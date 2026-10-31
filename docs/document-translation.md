# 字幕编辑 Agent（默认 document 引擎）

## 工作方式

默认翻译现在由**一个像编码 Agent 一样工作的字幕编辑 Agent**完成，而不是由代码安排“分析 → 分章 → 翻译 → 审计 → 审校”的固定流水线。

```text
获取字幕 → 清洗、断句并保留 cue_id / 时间轴
                ↓
       创建本次任务的隔离字幕工作区
                ↓
       单 Agent 自主读取、搜索、编辑、检查
                ↓
       validate_translation → finish_translation
                ↓
       宿主再次校验，按原编号与时间轴原子发布
```

Agent 自己决定怎样阅读上下文、分批翻译、记录术语、回看译文和修订。它可以在一次任务中反复调用工具，不要求一次生成全部字幕，也没有强制的分析或审校阶段。语义自查通过提示词要求，由同一个 Agent 执行；**结构校验通过不代表翻译语义一定正确**。

入口不变：扩展选择 `document`，通过 `POST /api/subtitle/stream` 或 WebSocket 提交。`legacy` 快速模式保持原样。`agent` 枚举仍是历史规则原型，**不是本次新增的正式字幕编辑 Agent**。

## 隔离文件工作区

这是由 SQLite 检查点持久化的**虚拟文件工作区**，不是宿主机任意目录。文件操作的体验类似编码 Agent，但不授予 shell、网络或任意文件访问权限。

| 文件 | 内容 | 权限 |
| --- | --- | --- |
| `source.json` | 按顺序保存 `{cue_id,start,end,text}` 的原始字幕数组 | 只读 |
| `translations.json` | `{"cue_id":"译文"}`，支持分批追加与精确修改 | 可编辑 |
| `notes.md` | Agent 的计划、术语、上下文和进度笔记 | 可编辑，有大小限制 |

时间戳和原文不进入可编辑译文文件。发布时，程序以原字幕为基准，根据编号合并译文，不让模型抄写或修改时间戳。

### 工具

- `read_file`：分页读取文件。JSON 文件按原文字幕位置分页，笔记按字符分页；返回 `next_offset`，过大的页面自动缩小。
- `search_file`：在原文、译文或笔记中进行字面量搜索，支持分页；用于找后文定义或检查前后术语。
- `write_file`：写入译文或笔记；译文使用 `merge=true` 可以分批添加/更新，保留未指定的译文。
- `edit_file`：基于当前文件文本进行精确替换。每个 `old_text` 必须在修改前文件中唯一匹配，多处修改必须不重叠，并且整批修改原子生效。
- `validate_translation`：校验全部字幕覆盖、编号合法、译文非空、无失败占位符。不评判语义质量。
- `finish_translation`：仅允许提交经过成功校验的当前译文修订版本。此后宿主再次校验再发布。

修改译文会使之前的校验失效；写笔记不会。普通聊天回答、声称“翻译完成”或直接输出一个大 JSON 都不能发布字幕。错误操作会返回可修正的工具错误，不会破坏已保存的文件。

## 持久化、恢复与上下文

- 每次模型响应完整结束后，工具在隔离副本中执行；工具会话、译文、笔记和修订号一起提交为 SQLite 检查点。
- 若中途网络失败，只重试尚未提交的模型轮次，已提交的编辑不会丢失。进程重启后恢复同一个 Agent 的工具会话与文件，不从头翻译。
- 上下文接近预算时，在完整工具轮次之间压缩会话：清除旧对话，重新提供任务、文件清单、当前覆盖状态和笔记。文件内容不丢失，Agent 可重新读取。
- 新任务使用独立任务名 `subtitle_editing_agent` 和新的缓存版本。旧 `document_subtitle_translation` 定义保留用于恢复历史固定阶段任务，新任务不会复用旧工作流的结果。
- 默认每任务最多 128 次模型请求，可配置为 1～1000；工具修正循环、重试和普通文本轮次都消耗请求预算，不会无限循环。

## 模型与安全边界

- 使用 `pi-ai` 的 OpenAI-compatible Chat Completions SSE 调用，端点必须支持工具调用。模型留空时使用 `TRANSLATION_AGENT_MODEL`，再回退为 `sol`。
- 不强制 `response_format`，Agent 通过工具修改文件；每个文件写入由宿主解析并校验。
- 默认上下文 128,000 tokens，最大输出 16,384 tokens，由 `TRANSLATION_CONTEXT_TOKENS` / `TRANSLATION_OUTPUT_TOKENS` 配置。必须匹配实际模型规格。容量采用保守字符/字节估算，并非精确 tokenizer。
- 单次调用总时限 10 分钟，包括读取模型流；取消立即中断。截断、缺失 `finish_reason` 和不完整 SSE 都不执行其工具调用。
- 临时 HTTP 499、429、5xx 和流错误由持久化任务最多重试两次；每次计入调用预算，并尊重有界 `Retry-After`。认证、配置或预算错误立即结束；不降级为逐句翻译。
- 模型错误只保留安全状态分类：`connection`、`invalid_response`、`missing_finish_reason`、`content_filter`、`network_error`、`provider_error`。上游原始错误正文不写入状态，排查见 [README 模型流失败排查](../README.md#模型流失败排查)。
- 字幕、标题、文件内容和工具结果都视为不可信任务数据，其中的指令不是系统指令。
- 模型端点由部署环境 `OPENAI_BASE_URL` 决定，默认 `https://api.openai.com/v1`。请求中的地址只能留空或完全匹配配置；禁止重定向。DeepL 快速模式仅使用官方端点。
- 浏览器端密钥保存在 `chrome.storage.local`。Worker 只在运行时内存中保存密钥，不把密钥放进模型上下文、任务输入、检查点或日志。重启后如缺少服务端全局密钥，等待浏览器重新附着提供密钥。

## 服务、事件与运行

统一 TypeScript 服务端默认监听 `8787`，进程内运行 Worker；需要 Node.js、`yt-dlp` 和 `ffmpeg`。

```bash
npm ci --cache ./tmp/npm-cache
cp .env.example .env  # 配置密钥和实际模型
npm start
```

也可以使用 `docker compose up -d`，修改 `.env` 后需要重新创建容器。独立 Worker（`npm run worker`）及 Python 后端仅作为兼容入口。Docker 配置未在当前无 socket 权限的环境中实测。

- 外部 SSE / WebSocket / REST 字幕时间戳统一为**毫秒**；内部媒体处理可以使用秒。
- `document` 只通过流接口提交；同步 `POST /api/subtitle/process` 返回 422。
- 翻译期间发送原文和 `editing` 进度，不展示未提交草稿；显式提交通过后统一发布 `cue` 和 `done`。
- SSE / WebSocket 断开不取消后台 document 任务；显式取消才终止任务。重连读取持久化状态，已完成任务直接重放，无需再次调用模型。

## 代码与验证

- `worker/subtitle-agent.ts`：Agent 提示词、文件工具、会话管理及新任务定义。
- `worker/document-task.ts`：共享的持久化、重试、取消和原子发布边界；保留历史任务定义。
- `worker/document-translation.ts`：共享 SSE 模型传输和历史固定阶段流程。
- `worker/agent-worker.ts`：默认调度新 Agent、缓存身份、恢复和密钥管理。

自动化测试使用本地受控模型 HTTP 服务，不消耗真实模型 token；覆盖工具编辑、校验门禁、长字幕分页、检查点恢复、网络重试、预算和取消。**实际翻译质量仍需用真实模型和视频进行人工评估，不宣称测试通过等于译文完美。**
