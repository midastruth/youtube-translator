# YouTube Translator

YouTube 双语字幕翻译系统 — 统一 TypeScript 服务端 + 轻量浏览器扩展。

```text
youtube-translator/
├── server/              统一 TypeScript 服务端（单端口 8787，内置 Worker）
├── worker/              字幕编辑 Agent（pi-durable 持久化与文件工作区）
├── extension/           轻量浏览器扩展（Chrome 121+ / Firefox 128+）
├── backend/             [历史兼容] Python FastAPI 后端 (youtube-ingest)
├── docker-compose.yml
├── Makefile
└── README.md
```

## 架构

```text
浏览器 (extension)
  │  调用 HTTP / SSE / WebSocket（默认单一地址 http://localhost:8787）
  ▼
统一 TypeScript 服务端 (server/src)
  │  yt-dlp CLI / 浏览器字幕兜底 / Whisper 媒体转写 → 清洗展平与智能断句
  ├─ 字幕编辑 Agent (document) ── 进程内存零跳转 ──► 内置 AgentWorker
  │                                                  ├─ 原文只读，译文与笔记可编辑
  │                                                  ├─ 单 Agent 自主阅读、搜索与修改
  │                                                  ├─ 文件和会话按轮持久化，可恢复
  │                                                  └─ 校验当前修订后显式提交、原子发布
  └─ 快速模式 (legacy) ──► 独立逐句 / 10~12 条上下文分块快速翻译 (OpenAI / DeepL)
  ▼
SSE / WebSocket 实时回传事件（外部字幕时间轴统一为毫秒） → 扩展渲染到 YouTube 播放器
```

> **架构演进说明**：系统已全面升级为以 TypeScript 单体架构为主（`server/` 默认内置 `worker/`，监听单一端口 `8787`）。原 Python 后端已沉淀为历史兼容实现，不再是运行时依赖。

---

## 快速开始

### 1. 启动服务端（默认单端口 8787 内置 Worker）

**系统环境与外部依赖**：
- **Node.js**：`^22.22.2 || ^24.15.0 || >=26.0.0`
- **系统工具**：系统 `PATH` 中需具备 **`yt-dlp`**（用于提取视频字幕与音频流）及 **`ffmpeg`**（用于音频切块分段与 Whisper 媒体处理）。

在项目根目录下执行：

```bash
# 1. 必须先安装锁定依赖（不能省略）
npm ci --cache ./tmp/npm-cache

# 2. 复制环境变量配置并填入 API Key
# （npm start 会自动通过 node --env-file-if-exists=.env 读取根目录 .env）
cp .env.example .env   # 编辑填入 OPENAI_API_KEY 或 TRANSLATE_API_KEY

# 3. 启动统一服务端（监听 8787 端口，进程内已内置 AgentWorker）
npm start
# 或者使用 Makefile 启动：
make start
```

也可以使用 Docker Compose 启动：

```bash
docker compose up -d
```

Docker Compose 默认只启动 `server`（统一 TypeScript 单体服务）与 `pot-provider`（PoToken 挑战辅助），直接在宿主机暴露 `8787` 端口。

> **环境与测试边界提示**：当前开发环境中宿主机 Docker socket 存在权限限制（`socket permission denied` on `/var/run/docker.sock`），无法连接 Docker 守护进程；本项目不声称已在当前环境中实测构建或运行真实 Docker 镜像，所有自动化测试均在纯本地 Node 环境下运行；上述 Docker 命令遵循标准的 Dockerfile / Compose 配置契约。

#### 可选历史兼容入口（选读）
- **独立内部 Worker**：如需单独以独立进程/端口（8788）运行 Worker 调试，可执行 `npm run worker` 或 `docker compose --profile legacy up worker`。
- **Python 后端实现**：保留在 `backend/` 目录下供对比与历史参考，若需启动可执行 `make start-backend`。

---

### YouTube 反爬 / 400 排查

如果扩展显示 `字幕加载失败：Backend 400`，先查看服务端日志或返回的 `detail`。当前最常见原因是 yt-dlp 请求 YouTube 时被触发机器人验证，而不是翻译 API 错误。

1. 用浏览器 Cookie 导出工具导出 **Netscape cookies.txt**（不要导出 JSON）。
2. 将文件保存为 `./cookies/youtube-cookies.txt`。
3. 在项目根目录 `.env` 中指定 Cookie 路径（**区分本地与容器**）：
   - **本地 Node 运行 (`npm start` / `make start`)**：
     ```env
     YTDLP_COOKIES_FILE=./cookies/youtube-cookies.txt
     # 或使用宿主机绝对路径
     ```
   - **Docker Compose 容器内运行**（宿主机 `./cookies` 目录已挂载到容器内 `/run/secrets`）：
     ```env
     YTDLP_COOKIES_FILE=/run/secrets/youtube-cookies.txt
     ```
4. 重启或重新加载服务端：
   - **本地运行**：直接重启 `npm start` 即可。
   - **Docker Compose**：修改 `.env` 后须执行 `docker compose up -d --force-recreate` 以确保新环境变量在容器内生效。

Cookie 文件仅限本机使用，不要提交到 Git；YouTube Cookie 失效后需重新导出。

### 模型流失败排查

`Model API stream failed` 表示模型调用失败，不是 YouTube 字幕提取失败。新版提示带有安全错误分类（不会显示上游原始正文或密钥）：

- `connection`：检查运行服务端的机器/容器能否访问模型接口，以及代理、TLS、`OPENAI_BASE_URL`；模型请求不跟随重定向。
- `invalid_response`：接口以 HTTP 200 返回 JSON/HTML 而不是 SSE。`OPENAI_BASE_URL` 应为 API 根路径（例如 `https://api.openai.com/v1`），不要填写网页地址或完整 `/chat/completions` 路径。
- `missing_finish_reason`：流结束但缺少 `choices[].finish_reason`；检查上游 SSE 兼容性与网关超时。仅返回 `[DONE]` 不足以确认输出完整，系统不会接受可能被截断的译文。
- `content_filter` / `network_error`：上游明确报告内容过滤或网络错误；检查其策略或服务状态。
- `provider_error`：其他流内错误；确认模型支持 `/chat/completions` SSE 和工具调用，并在上游服务侧查看详细原因。

如果仍只有旧版 `failed or ended prematurely` 提示，请更新并重启服务端；排查时提供错误分类、API 基础地址和模型名，**不要提供 API Key 或带密钥的日志**。

### 浏览器字幕兜底

若服务端 yt-dlp 被拦截或找不到可用字幕轨道，浏览器扩展会自动读取 YouTube 播放器自身已加载的字幕（json3，保留逐词时间戳），上传给服务端走同样的断句与翻译流程。该兜底只在服务端无法提供轨道时启用，不会将浏览器的敏感 Cookie 发给服务端。

---

### 2. 构建并加载扩展

在项目根目录构建扩展：

```bash
npm run typecheck
make build-extension
```

扩展源码在 `extension/src/*.ts`；生成的 JS 产物位于 `extension/public/*.js`。支持 Chrome 121+ 和 Firefox 128+。

- **Chrome**：打开 `chrome://extensions`，开启「开发者模式」，选择「加载已解压的扩展程序」，选择 `extension/public/`。
- **Firefox**：打开 `about:debugging#/runtime/this-firefox`，选择「临时载入附加组件」，选择 `extension/public/manifest.json`。

加载后，在扩展选项页确认后端地址为 `http://localhost:8787`。

---

### 3. 打开 YouTube

打开任意 YouTube 视频 → 点击播放器右下角翻译按钮开启双语字幕。每次页面加载或 SPA 切换视频均默认关闭。

---

## 翻译引擎与质量说明

新安装默认使用“字幕编辑 Agent”（`document` 模式）；已有显式保存的快速模式设置保持不变；可在扩展设置中切换。

### 翻译模式区分

1. **字幕编辑 Agent (document)**：
   - **像编码 Agent 一样工作**：一个真实大模型自主读取、搜索、编辑和自查字幕，不再强制执行分析、分章、审计等固定阶段。
   - **隔离文件工作区**：`source.json` 保留原文、编号和时间轴且只读；Agent 用 `read_file` / `search_file` / `write_file` / `edit_file` 操作 `translations.json` 与 `notes.md`。文件由 SQLite 检查点持久化，不开放任意宿主文件或 shell。
   - **分批编辑与恢复**：长字幕可分页读取、逐批写入和反复修改；工具会话与文件按轮保存，重启后继续。上下文过长时压缩会话，保留文件与笔记。
   - **显式提交**：Agent 自查后调用 `validate_translation`，当前修订校验通过才能 `finish_translation`。修改译文会使校验失效；普通回答不能发布，宿主再次校验后统一发布双语字幕。
   - **模型与预算**：使用 `pi-ai` Chat Completions SSE + function tools；默认模型 `sol`，可配置。单次调用最多 10 分钟，临时 HTTP 499、429、5xx 等最多重试两次，所有轮次计入任务预算。
   - **质量边界**：编号、时间轴和完整性由程序保证；语义质量依赖真实模型的理解与自查能力，结构校验不等于语义审校。自动化测试不消耗真实模型 token。
   - 历史固定阶段工作流仅保留用于恢复旧任务，新任务使用独立版本，不复用旧工作流缓存。

2. **快速模式 (legacy)**：
   - 适用于快速生成，支持 OpenAI-compatible 与 DeepL API。
   - 按 10~12 条一组带 `[$i]` 标记的上下文小块并发翻译，若解析不全则退回逐句补齐。

3. **旧版 Agent 原型框架 (agent)**：
   - `worker/task-definition.ts` 中的旧 `agent` 引擎仅为规则与 `defaultDraft()` 占位示例框架，**未接真实模型产品化**；请勿将测试原型与正式的 `document` 文档翻译工作流混淆。

### 时间戳契约与安全边界

- **时间戳对齐**：服务端内部媒体处理与 Whisper 分段使用秒（seconds），但对外（向浏览器扩展传递的 SSE / WebSocket 事件及 REST 接口）的字幕时间戳（`start` / `end`）**严格统一为毫秒 (milliseconds)**，与 YouTube 播放器的时钟对齐。
- **密钥安全与存储**：
  - **扩展前端**：用户在选项页配置的 API Key 会持久化存储于浏览器的本地扩展存储（`chrome.storage.local`）中，用户须妥善保护本机浏览器 profile 安全。
  - **服务端与 Worker**：请求中携带的密钥仅留存于运行时内存中用于发起 LLM 调用，**绝不写入任务检查点数据库（SQLite）或任何磁盘文件**。

实现与限制细节详见 [`docs/document-translation.md`](docs/document-translation.md) 与 [`docs/translation-architecture.md`](docs/translation-architecture.md)。

---

## 开发与测试

全部核心功能、服务端、扩展与验收套件均由现代 TypeScript 维护，无需全局安装 TypeScript。

```bash
npm run typecheck       # 严格检查 server、worker、扩展及单元测试类型
npm run build           # 构建 server、worker 以及扩展产物
npm run test:unit       # 运行全套独立单元测试
npm test                # 单元测试 + Gherkin 验收测试套件
npm run test:property   # 单独运行基于 fast-check 的属性测试
npm run verify          # npm test 后再显式运行属性测试
npm run test:coverage   # 测试覆盖率统计
```

### 验收测试工具说明

验收测试管线依赖 **Babashka 1.13.225** 与 APS 提供的 **`gherkin-parser`** 在系统 PATH 中：
- SwarmForge 环境可先运行 `swarm_tool.sh require gherkin-parser`，缺失时运行 `swarm_tool.sh ensure gherkin-parser`。
- `npm run test:acceptance` 顺序执行构建、APS 解析、Babashka 生成以及可执行 Cucumber 适配器测试。
- 测试夹具在 `./tmp/` 隔离受控的 HTTP 与 SQLite 数据库，使用受控的 mock 服务验证流程边界，不会在 CI 中消耗真实外部模型 token。
