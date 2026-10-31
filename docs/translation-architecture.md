# YouTube 双语字幕翻译架构

当前仅保留两种翻译模式：多 Agent 字幕编辑团队（`document`）与轻量快速翻译（`legacy`）。

> **历史架构图说明**：仓库中保留的 `docs/translation-architecture.png` 为早期 Python 后端经网络中转调度外部 Node Worker 的历史架构设计，仅作历史对比存档参考；当前生产运行架构完全以本文描述的 **TypeScript 统一单体服务（单端口 8787、内置 Worker 内存直连）**为准。

---

## 1. 总体架构

```mermaid
flowchart TD
    U[用户在 YouTube 播放器开启双语字幕] --> E[浏览器扩展 extension]
    E --> T[GET /api/subtitle/tracks]
    T -->|有可用字幕轨道：人工优先，再自动字幕| Y[服务端 yt-dlp CLI 提取 JSON3]
    T -->|无字幕轨道 / 后端被拦截| B[bridge.ts 读取播放器自身字幕]
    B -->|读取成功：上传 source_events / source_cues| P[清洗、去重、过滤非语音、展平时间轴]
    Y --> P
    P --> S[规则 rule / 统计 statistical 智能断句]
    S --> C[生成基准 SubtitleCue：秒级时间轴与 cue_id]
    B -->|读取失败且开启 Whisper| W[服务端 WhisperClient 媒体转写兜底]
    W -->|下载音频 → ffmpeg 切块 → Whisper API| C
    
    C --> Q{translate_engine}
    
    Q -->|document：默认字幕编辑 Agent| DW[主 Agent 规划风格、术语和语义分段]
    DW --> CHILD[开头专用 Agent + 最多 9 个后续 Agent 独立连续翻译]
    CHILD -->|开头自查提交后先发预览| SSE
    CHILD --> REVIEW[主 Agent 全文验收、关闭子 Agent、校验并提交]
    DW <--> DB[(SQLite：主/子文件工作区与工具会话)]
    CHILD <--> DB
    DW <--> LLM[pi-ai 流式调用：ChatCompletions SSE + Tools]
    CHILD <--> LLM
    
    Q -->|legacy：快速模式| L[server/src/translate.ts 快速翻译调度]
    L <--> API[OpenAI-compatible / DeepL API]
    
    REVIEW --> SSE[SSE / WebSocket 事件分发：毫秒时间轴转换]
    L --> SSE
    SSE --> E
    E --> R[按 video.currentTime 渲染双语字幕]
    
    FC[(服务端文件缓存 SubtitleCache)] -.-> Y
    FC -.-> C
    FC -.-> L
    L -.->|保存成功块译文| FC
```

### 核心运行机制说明
1. **单一入口与内存直连**：浏览器扩展默认统一请求 `http://localhost:8787`（通过 `POST /api/subtitle/stream`）。服务端在同进程内直接持有并调度 `AgentWorker` 实例，消除进程间网络跳转。
2. **时间戳规范**：服务端内部算法及 Whisper 原生片段使用秒（seconds）；向外分发给浏览器扩展与播放器前，**严格统一转换为毫秒 (milliseconds)**。
3. **Whisper 兜底边界**：默认关闭；仅在视频无任何人工或自动字幕且用户显式启用时触发，需依赖 yt-dlp 下载音频与 ffmpeg 切块。

---

## 2. 快速翻译模式 (Legacy 流程)

```mermaid
flowchart TD
    C[已断句的原文 cues] --> CACHE[SubtitleCache：读取匹配配置的翻译缓存]
    CACHE --> EARLY[先发 meta 与全部 source_cue，再回传缓存 cue]
    EARLY --> P[收集待翻译字幕]
    P --> MODE{translate_whole 为真，或总条数 >= 100？}
    MODE -->|是| CT[每组 10~12 条：带 [$i] 标记的上下文提示]
    MODE -->|否| BT[每组 12 条：块内逐句并发翻译]
    CT --> RUN[限制并发调用外部 API]
    BT --> RUN
    RUN --> API[调用翻译 API：OpenAI 或 DeepL]
    API --> PARSE[parseWholeResponse：解析 [$i] 索引并回填]
    PARSE --> OUT[逐条推送 cue 事件，写入缓存]
    OUT --> DONE[发送 done，附 failed_cues 统计]
    DONE -->|存在失败，扩展可按需重试| CACHE
```

- **上下文标记与防错位**：针对 OpenAI-compatible 接口使用 `[$i]` 标记，`parseWholeResponse` 严格匹配括号标记并按索引回填；若模型返回行数不全或格式残缺，自动退回逐句补齐，杜绝行号错位。
- **DeepL 适配**：DeepL 不适用 OpenAI 格式提示词，自动分流至逐句并发翻译通道。
- **超时保护**：所有外部 HTTP 请求均由 AbortController 监控，超时覆盖从发起到 Body 完全读取的完整生命周期。

---

## 3. 全文高质量模式 (Document)

### 多 Agent 字幕编辑团队
- **实现位置**：`worker/translation-team.ts`，复用 `worker/subtitle-agent.ts` 的文件工具、`worker/document-task.ts` 的持久化边界和共享模型传输。
- **驱动方式**：主 Agent 快速评估内容、风格和术语，用 `dispatch_subagents` 分派约占视频前 1/6 的开头片段（1 小时视频约前 10 分钟），以及最多 9 个后续语义片段。子 Agent 使用独立会话连续推进，不逐轮互等；模型端点需支持 Chat Completions SSE 与 Function Calling，不要求 `response_format`。
- **工作区**：只读 `source.json`、可编辑 `translations.json` 和 `notes.md` 均为 SQLite 持久化的虚拟文件。子 Agent 只能写自己片段，但能通过 `read_context` 查阅全文；所有子任务共享不可变风格与术语规范，不开放 shell 或任意宿主路径。
- **持久化循环**：每个主/子回合完成后保存检查点，保留独立会话、文件和错误状态；失败只重试相应子任务，退避不阻塞兄弟任务。主、子请求及重试共用预算，默认 `0` 不限次数。重启仅可能重做尚未保存的在途回合。
- **发布门禁**：开头 Agent 自查、校验并显式提交后，宿主保存 `preview_cues` 并先发 `provisional: true` 预览，供边看边等后续翻译。全部子任务提交合并后，主 Agent 语义检查与修订，再 `accept_translation` → `close_subagents` → `validate_translation` → `finish_translation`。修改译文使验收和校验失效；宿主复核后原子发布全文，以相同索引覆盖开头预览，只有此时发送 `done`。
- **质量与性能边界**：结构由程序保证，语义由子 Agent 翻译与主 Agent 验收负责；无法由结构校验保证语义正确，实际加速比受模型服务并发限流影响。
- **任务边界**：仅注册 `subtitle_translation_team`，保留团队任务的恢复能力。旧单 Agent、固定阶段流程及规则原型已移除，其历史任务不能续翻，需重新开始。详见 [主/子 Agent 翻译](document-translation.md)。

---

## 4. 关键源码位置

| 层级 | 文件路径 | 职责与技术栈 |
| --- | --- | --- |
| **浏览器前端** | `extension/src/content.ts` | 播放器 UI 交互、SSE/WS 客户端、毫秒时钟渲染 |
| **浏览器字幕** | `extension/src/bridge.ts` | 播放器内部 json3 字幕窃听与兜底抓取 |
| **网关服务端** | `server/src/server.ts` | 单体统一服务端入口，负责进程初始化与端口监听 |
| **路由编排** | `server/src/app.ts` | 原生 Node HTTP 路由、SSE 长连接分发、内置 Worker 调度 |
| **缓存层** | `server/src/cache.ts` | 目录隔离、原子写入、LRU 淘汰与 TTL 维护（无死锁设计） |
| **媒体转写** | `server/src/transcribe.ts` & `audio.ts` | ffmpeg 分块、Whisper API 转写及秒级时间轴拼接 |
| **快速翻译** | `server/src/translate.ts` | Legacy 模式快速翻译、`[$i]` 标记解析与超时防护 |
| **字幕断句** | `server/src/subtitle-processing.ts` | 文本清洗、非语音段落过滤、规则与统计智能断句 |
| **翻译团队** | `worker/translation-team.ts` | 主 Agent 规划验收、开头 + 最多 9 个后续 Agent 独立推进、预览与最终发布门禁 |
| **共享 Agent 工具** | `worker/subtitle-agent.ts` | 主/子 Agent 文件工具、会话与上下文压缩 |
| **模型传输** | `worker/document-translation.ts` | 共享 SSE 模型调用与配置、Token 预算 |
| **持久化任务边界** | `worker/document-task.ts` | pi-durable 检查点、重试、预算、取消与原子发布 |
| **AgentWorker 核心** | `worker/agent-worker.ts` | 任务队列管理、事件流观察、生命周期调度 |
| **任务文档** | `worker/job-document.ts` | 团队与流式观察者共用的持久化状态 |
| **[历史兼容实现]** | `backend/src/youtube_ingest/server.py` | 原 Python FastAPI 后端，仅作历史兼容参考保留 |

---

## 5. 部署、环境与安全说明

- **Docker 单容器集成**：`docker-compose.yml` 默认启动单一 `server` 容器（内置 Worker）与辅助 `pot-provider`。旧版独立 Worker 标有 `profiles: [legacy]`，默认不启动。
- **测试环境边界说明**：当前开发环境中宿主机 Docker socket 存在权限限制（`socket permission denied` on `/var/run/docker.sock`），无法连接 Docker 守护进程；本项目不声称已在当前沙箱中实测构建或运行真实 Docker 镜像，所有单元测试与集成测试均在原生 Node 环境执行并使用受控 mock 验证协议健全性。
- **密钥安全与存储边界**：
  - **扩展前端**：用户配置的 `translateApiKey` 与 `whisperApiKey` 会被保存于浏览器本地扩展存储（`chrome.storage.local`）中，用户须保护好本机浏览器 profile 安全。
  - **服务端 / Worker**：请求中携带的密钥仅留存于运行时内存中用于发起 LLM 调用，严格不写入 SQLite 任务数据库（`worker-storage.db`）或磁盘检查点，确保密钥不持久化落盘。
