# 文档级字幕翻译 (Document-Level Subtitle Translation)

## 入口与运行

浏览器扩展选择 `document`（全文高质量）引擎，请求核心接口 `POST /api/subtitle/stream`。

### 统一单体服务运行架构（新产品默认）
系统已将字幕提取、断句网关与文档翻译 Worker 整合为**单进程 TypeScript 服务端**（`server/src`），默认监听单一端口 `8787`。

**本地运行前置条件**：需安装 Node.js，并在系统 PATH 中安装 **`yt-dlp`** 与 **`ffmpeg`**。
```bash
# 1. 安装锁定依赖
npm ci --cache ./tmp/npm-cache

# 2. 根目录启动单体统一服务（默认单端口 8787，内置 AgentWorker，无需多进程跳转）
npm start
# 或使用 Makefile
make start
```

也可以使用 Docker 部署：
```bash
docker compose up -d
```
Docker Compose 默认只启动 `server` 与 `pot-provider`，单端口 `8787` 对外暴露。修改 `.env` 配置后应执行 `docker compose up -d --force-recreate` 重新加载。
如需使用 YouTube 反爬 Cookie，本地 Node 进程指定 `YTDLP_COOKIES_FILE=./cookies/youtube-cookies.txt`（Docker 容器内为挂载路径 `/run/secrets/youtube-cookies.txt`）。
Worker 任务数据库持久化保存在命名卷 `server-data`（默认路径 `/app/cache/worker-storage.db`），即使浏览器连接断开或重启，后台持久化任务亦不受影响。

### 历史兼容说明 (Legacy)
- **独立内部 Worker**：如果需要单独作为独立微服务运行 Worker（监听内部端口 `8788`），可通过 `npm run worker` 或 `docker compose --profile legacy up worker` 启动。
- **Python 后端**：旧版 `backend/` 需通过 HTTP 转发到独立的 Worker 端口；此模式属于历史兼容实现，不再是系统运行依赖。

---

## 引擎分类与真实模型区别

系统存在三类不同的翻译引擎配置，文档与调用方需准确区分：

1. **`document` 模式（正式全文高质量工作流）**：
   - **真实大模型驱动**：由 `worker/document-translation.ts`、`worker/document-task.ts` 和 `worker/document-stream.ts` 驱动。
   - 要求模型端点支持标准 `/chat/completions`、`response_format: json_object` 以及 function calling 工具调用。
   - 具备全局理解、层次化阅读笔记、语义章节规划、双语审校与跨章节一致性审计等全套工作流。
2. **`legacy` 模式（快速分块翻译）**：
   - 由 `server/src/translate.ts` 驱动，支持 OpenAI-compatible 与 DeepL API。
   - 采用 10~12 条带 `[$i]` 标记的上下文小块并发翻译，若解析不全则退回逐句补齐。
3. **`agent` 模式（旧版状态机原型）**：
   - 位于 `worker/task-definition.ts` 中的旧 agent 状态机仅为规则和 `defaultDraft()` / `reviewer.ts` 占位示例框架，**未接真实模型产品化**；请勿将测试原型与正式的 `document` 文档大模型翻译工作流混淆。

---

## 时间戳与外部接口契约

- **外部时间戳单位**：服务端向浏览器扩展发送的所有字幕事件（`source_cue`、`cue` 等）及 REST 响应中的 `start` 与 `end` **严格为毫秒 (milliseconds)**，保证与浏览器端 YouTube 播放器的毫秒时钟精确匹配。
- **流式约束**：非流式接口 `POST /api/subtitle/process` 对 `document` 引擎严格返回 HTTP 422，避免调用方将耗时较长的高质量长视频任务误当成 30 秒以内的同步 REST 请求。
- **连接与流控**：SSE 与 WebSocket 均等待发送完成/可写后再发送下一条事件。Legacy SSE 在等待模型时每 5 秒发送 keepalive，同视频/配置的并发请求被拒绝以避免重复计费；断开连接会中止 legacy 模型请求，但 document 后台任务继续执行。
- **长连接与双向通道**：SSE (`POST /api/subtitle/stream`) 与 WebSocket (`/api/subtitle/ws`) 均可完整接收 `document` 引擎的生命周期事件（`meta`、`source_cue`、`progress`、`cue`、`done`、`error`）。

---

## 状态机与工作流

`worker/document-task.ts` 借助 `pi-durable` 将任务拆解为持久化阶段检查点，状态存储于 SQLite：

1. **analyze**：读取完整原文，形成意图、受众背景、主题笔记、术语映射表及按语义切分的章节计划。
2. **consolidate / brief**：对超长原文的多篇阅读笔记进行层次化归并，统一全文上下文摘要与关键术语理解。
3. **translate**：当输入与预计输出容量足够时合并为全文单次翻译；否则按语义章节逐章翻译，各章共享全文理解。
4. **audit**：结合全文背景与各章译稿，检查跨段落术语统一性与指代冲突；过长笔记自动层次化归并。
5. **review**：结合全文背景、跨章审计结论、相邻上下文及只读检索工具执行双语双向审校。发现错误后记录修改建议并重审，单范围最多进行两轮语义修订。
6. **final_audit**：基于全部审校完成的实际译文做全局最终一致性审计，防止局部修改破坏全局协调性；必要时执行指导重审。
7. **publish**：严格核对全部 `cue_id` 映射无缺失、无冗余后原子发布译文；审校未完全通过前仅展示原文并推送进度，严禁发布半成品或未审校草稿。

---

## 上下文容量与边界约束

- **安全余量预算**：统一预估模型输入上下文、输出最大 tokens、工具声明及会话检索历史。
- **默认配置**：默认上下文 128,000 tokens、最大输出 16,384 tokens；由 `TRANSLATION_CONTEXT_TOKENS` 和 `TRANSLATION_OUTPUT_TOKENS` 环境变量定义，必须根据所选实际模型的真实规格配置。
- **估算机制**：基于保守的字符/字节估算，不保证与所有模型的私有 tokenizer 完全一致；模型端真实触发截断会被捕获并判定为失败，严禁吞咽或使用残缺译文。
- **长视频伸缩**：超出单次上下文容量时，阅读阶段采用分层滑动窗口；各章节提议由大模型结合语义生成，宿主校验其连续性与预算合规。

---

## 受限只读工具

大模型在执行过程中仅可调用两个受限工具：
- `read_transcript`：读取当前视频任意位置的原文与已有阶段译稿（支持分页与大小限制）。
- `search_transcript`：在当前视频中基于关键词搜索原文与译文段落。

工具**无宿主 Bash 执行权限、无任意文件读写、无外网访问**。字幕文本中出现的任何“系统指令”或“提示注入”仅被视为待翻译的普通字符串。

---

## 模型端点信任边界

- OpenAI-compatible 模型端点只能由部署环境的 `OPENAI_BASE_URL` 配置（未配置时为 `https://api.openai.com/v1`）。请求中的 `translate_base_url` / `baseUrl` 必须留空或与该配置完全一致；不能通过请求选择其他域名、IP、端口或路径。
- 私有/本地模型服务必须由管理员显式配置；配置中的域名及其 DNS 属于部署信任边界，不接受用户提供的任意域名，因此不会先检查用户域名再进行第二次、可被重绑定的 DNS 查询。
- 模型请求禁止跟随重定向，防止将浏览器或服务端密钥转发到其他目的地。DeepL 仅允许官方 `https://api-free.deepl.com/v2` 端点。
- 模型设置留空时，全文翻译使用 `TRANSLATION_AGENT_MODEL`，再回退到内置默认模型。修改端点配置后，不符合新策略的持久化任务不会继续向旧端点发送请求。

## 校验、重试与恢复

- **章节覆盖校验**：章节区间必须严格连续且完全覆盖原始字幕 ID，禁止遗漏、倒序或引用未知 ID。
- **映射完整性**：译文必须具有明确的 `cue_id` 对应，严禁通过行数顺序猜测对应关系；译文不得为空或包含失败占位符。
- **时间轴只读**：字幕起止时间由宿主严格锁定，模型无权篡改时间戳。
- **任务预算与重试**：每次网络模型请求均占用任务预算计数（默认每任务上限 128 次调用）。认证失败、配置错误或预算耗尽立即终止，不降级为逐句机器翻译。
- **密钥安全与会话持久化**：
  - 扩展端的 API Key 会保存在用户的浏览器本地存储（`chrome.storage.local`）中，用户须妥善保护本机浏览器 profile 安全。
  - 服务端与 Worker 接收请求后，仅将 Key 保存在运行时内存中用于调用外部模型，**绝不写入任务检查点数据库（SQLite）或任何日志文件**。
  - 若服务端重启且服务端环境变量未配置全局 Key，后台未完成任务会保持等待状态，用户重新打开页面时扩展会通过请求自动带回密钥并附着恢复，无需为了恢复便利而在服务端落盘明文凭证。

---

## 验证与质量边界说明

- **测试套件边界**：单元测试与集成测试均在本地隔离环境下运行（使用受控本地 HTTP mock 服务与内存/临时 SQLite 数据库），主要验证任务协议、状态机转换、检查点恢复、预算限制、超时清理及异常边界。测试不消耗真实外部模型 token。
- **真实模型质量边界**：端到端工作流的校验通过证明架构机制健全，实际字幕质量取决于底层 LLM 的推理水平。上线使用需以真实长视频进行人工对比评估（重点关注歧义词、前后术语对应、长句断句阅读流畅度等）。
- **容器环境权限边界**：本项目的 Dockerfile 与 docker-compose.yml 遵循标准镜像规范，但在受限开发沙箱或当前测试环境中，由于宿主机 Docker socket 权限受限（`socket permission denied` on `/var/run/docker.sock`），无法连接 Docker 守护进程；本项目不声称已在当前环境中实测构建或运行真实 Docker 镜像，所有单元测试与集成测试均在原生 Node 环境执行并使用受控 mock 验证协议健全性。
