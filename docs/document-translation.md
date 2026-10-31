# 主 Agent + 子 Agent 翻译（默认 document 引擎）

## 工作方式

```text
获取字幕 → 清洗、断句，固定 cue_id / 时间轴
                ↓
主 Agent 快速阅读代表性上下文，评估风格、受众、语气与术语
                ↓
dispatch_subagents：共享规范，分派开头专用 Agent + 最多 9 个后续 Agent
                ↓
各 Agent 独立连续推进，每完成一回合就保存，不逐轮互等
                ├─ 开头 Agent 自查、校验并提交 → 立即推送开头预览，可先观看
                ↓
全部片段完成，主 Agent 检查合并译文，修正术语、语义与片段衔接
                ↓
accept_translation → close_subagents
                ↓
validate_translation → finish_translation → 宿主复核、原子发布
```

主 Agent 根据内容与任务大小决定开头范围和其余子 Agent 数量，不是每次固定启动满额。新任务额外配置 1 个开头专用 Agent，加上最多 9 个后续 Agent（合计最多 10 个）；极短任务可以只有开头 Agent。主、子 Agent 使用同一模型和 token 配置，但可分别设置推理强度，并有独立工具会话和工作区。子 Agent 是独立模型会话，不是宿主机子进程；宿主并发执行模型调用，不授予 shell 或任意外网权限。

入口不变：扩展选择 `document`，通过 `POST /api/subtitle/stream` 或 WebSocket 提交。`legacy` 快速模式保持原样。`agent` 枚举仍是历史规则原型，不是正式翻译团队。

## 主 Agent：规划、分派、验收

主 Agent 先快速阅读开头和代表性的后文定义，形成共享规范，包括翻译风格、领域、语气、术语的源语言到目标语言映射；提示词要求避免在派发前逐页穷尽全文。随后调用 `dispatch_subagents`，提供：

- `brief`：所有子 Agent 共享的不可变翻译规范与术语表。
- `opening`：`{end_id,instructions}`，从第一条原文开始的开头专用片段。主 Agent 按总翻译量、字幕密度和语义边界选取小范围，提示目标通常为 30～90 秒、约 10～30 条普通字幕，并非硬编码条数。
- `assignments`：0～9 个按原文顺序排列的 `{start_id,end_id,instructions}`，覆盖开头之后的剩余原文。只有开头已覆盖全文时才允许为空。

程序检查片段必须完整覆盖全部字幕，不能重叠、遗漏、乱序或引用未知编号。派发只允许一次；主 Agent 在子任务完成后直接编辑合并译文来修正问题。

子任务执行期间主 Agent 等待，不额外调用模型。完成后主 Agent 回到原会话，读取实际译文，对照原文检查语义、术语和片段边界，必要时精确修改。

验收与关闭：

1. `accept_translation({review})`：记录主 Agent 对当前译文修订的语义验收摘要；要求子任务全部完成、译文覆盖完整。
2. `close_subagents()`：必须先验收，随后关闭子会话并释放对话和笔记，保留提交结果。
3. `validate_translation()`：结构校验当前修订。
4. `finish_translation()`：只有当前修订已验收、子 Agent 全部关闭且结构校验通过才能提交。

**修改译文会使原验收和结构校验失效**，需要重新验收和校验。程序不能判断验收摘要是否代表真正充分的语义检查；语义审查仍依赖主 Agent，结构校验不代表译文必然正确。

## 子 Agent：隔离并行翻译

每个子 Agent 收到相同的共享规范、自己片段的说明，以及独立虚拟文件：

| 文件 | 内容 | 权限 |
| --- | --- | --- |
| `source.json` | 自己片段的 `{cue_id,start,end,text}` | 只读 |
| `translations.json` | 自己片段的 `{"cue_id":"译文"}` | 可编辑 |
| `notes.md` | 计划、术语和进度笔记 | 可编辑，有大小限制 |

- 文件工具包括 `read_file`、`search_file`、`write_file`、`edit_file`。
- `write_file` 的 `merge=true` 支持分批追加；精确编辑要求唯一匹配且不重叠。
- `read_context` 可以按全局字幕位置分页读取或搜索全文，查找前后定义；全文始终只读。
- 子 Agent **不能写入其他片段编号**，也没有分派更多子 Agent 的工具。
- 子 Agent 校验并显式提交自己片段后，宿主复核再合并。未提交草稿不合并，更不会发布给浏览器。
- **开头优先预览**：只有开头 Agent 完成自查、结构校验和显式提交后，宿主才将结果与检查点同事务保存到 `preview_cues`，发送 `provisional: true` 的 `cue`。它尚未通过主 Agent 全文审校，不计为全文成功；其他子 Agent 的片段仍不提前发布。
- 原文、编号和时间轴由宿主掌握，不交给模型重写。

## 并发、持久化与恢复

- 主 Agent 每次执行一个模型回合；子 Agent 阶段由各子任务独立循环，完成自己的模型/工具回合并保存后立即进入下一回合，不等慢速兄弟任务。只在所有子任务完成后汇合，交回主 Agent 验收。
- 每个子回合（包括错误状态）完成后，将当前主/子会话、草稿和笔记保存为 SQLite 检查点；保存串行化且按入队时快照写入，防止旧快照覆盖新进度。重启只可能重做尚未保存的在途回合，不重译已提交的开头或其他子任务。
- 单个子任务临时失败最多重试两次，退避只阻塞自己，不阻塞其他子任务；遵守有界 `Retry-After`。重试耗尽或永久错误会使整个任务失败，不发布未验收的全文；已经自查提交的开头预览保留，可观看并续翻，但仍不是最终版本。
- 手动续翻恢复主、子会话和草稿；已完成子任务不重新翻译。可以重新尝试失败的子任务，但**不重置累计模型请求预算**。
- 主、子 Agent **默认关闭累计请求次数限制**（`0`），仍记录所有回合、普通文本回复与重试的实际调用数。可显式设置 1～1000 次上限，所有 Agent 共用一个池子，不是各自一份。关闭此限制不影响单次请求超时、临时失败重试上限或 Token 配置，但可能增加 API 费用。
- 旧任务的有限预算耗尽不是 API 余额或 Token 耗尽。扩展设置中的「Agent 任务请求预算」可填 `0` 关闭限制，或填 `512` 等更高上限，保存后重新开启翻译；留空继承服务端设置。服务端也可在 `.env` 设置 `TRANSLATION_REQUEST_BUDGET=0`，重启服务（Docker Compose 需 `docker compose up -d --build server` 重新创建容器），再以相同视频和翻译设置点击开始，从已保存工作区续翻。累计调用数不会清零。
- 失败时 `published_cues=0`、`failed_cues=全部条数` 表示未完成验收和原子发布，不代表检查点里的草稿已丢失。即使草稿覆盖完整，也必须续翻完成子 Agent 提交、主 Agent 验收和关闭，不能直接将草稿当作成功结果发布。
- SSE / WebSocket 请求可用整数 `translate_request_budget` 显式覆盖上限；`0` 关闭限制，1～1000 启用上限；优先级为请求值 → `TRANSLATION_REQUEST_BUDGET` → 原任务上限（新任务默认关闭）。未提供覆盖配置的旧任务保留原有上限，需显式传 `0` 或设置环境变量来关闭。预算不参与缓存键；调整不会创建新翻译任务，也不会改变正在运行任务的上限。
- 上下文过长时清除旧会话，保留文件、笔记、共享规范和分工，模型可重新阅读。
- 新任务使用 `subtitle_translation_team`、`streamOpening: true` 和 `subtitle-translation-team-v2-streaming` 独立缓存版本。历史团队任务仍可恢复，不强行补派开头 Agent；其原有片段改用独立推进。旧 `subtitle_editing_agent` 与 `document_subtitle_translation` 定义仍注册，用于恢复升级前运行中的任务；新任务不复用旧缓存。

## 模型、安全与发布

- 使用 `pi-ai` 的 OpenAI-compatible Chat Completions SSE + Function Calling，不强制 `response_format`。主、子 Agent 使用同一模型和 token 配置；推理强度可分别用 `TRANSLATION_MAIN_REASONING_EFFORT=high` 和 `TRANSLATION_SUBAGENT_REASONING_EFFORT=medium` 设置。
- 角色推理设置未指定或留空时继承 `TRANSLATION_REASONING_EFFORT`（默认 `off`），显式 `off` 表示该角色不发送推理强度参数。有效设置在任务创建时持久化，修改任一角色档位会隔离新任务缓存；重启、续翻仍使用任务原设置，旧任务不受新增环境变量影响。支持 `off` / `minimal` / `low` / `medium` / `high` / `xhigh`，实际档位需模型支持。
- 模型优先采用请求设置，再采用 `TRANSLATION_AGENT_MODEL`，最后回退为 `sol`。端点需允许最多 10 个并发请求（开头 1 + 后续 9）；限流可能降低收益，真实加速比取决于模型服务与任务分段。
- 默认上下文 128,000 tokens、最大输出 16,384 tokens；由 `TRANSLATION_CONTEXT_TOKENS` / `TRANSLATION_OUTPUT_TOKENS` 配置。预算采用保守估算，不是精确 tokenizer。
- 单次模型请求总时限 10 分钟。截断或缺少完整结束标记的调用不会执行工具。
- 模型端点受部署环境 `OPENAI_BASE_URL` 限制，禁止重定向。字幕、标题、笔记、共享规范与工具结果是任务数据，不是系统指令。
- 浏览器密钥保存在 `chrome.storage.local`；Worker 仅在内存中保存密钥，不写入会话、检查点或日志。重启后必要时由浏览器重新附着提供密钥。
- 服务端默认端口 `8787`，进程内内置 Worker。外部字幕时间戳统一为毫秒。
- 翻译期间推送原文、每个已保存回合的进度，以及开头已提交的预览，不展示未提交草稿正文；最终提交后统一发布全文 `cue`（`provisional: false`）和 `done`。扩展按原 `index` 覆盖开头预览，立即刷新当前字幕，不重复追加。重连会重放已保存的开头预览；只有最终完成才发送 `done`。
- 进度包含当前阶段、已保存草稿条数、已提交子 Agent 数、累计推进回合及重试/失败数；不是模型 token 级实时状态。草稿计数包含尚未提交的子任务工作区，合并后不重复计数；主 Agent 验收阶段以合并工作区为准。
- SSE / WebSocket 断开只分离观察者，不取消后台任务；显式取消会中断所有运行中的模型调用，清除开头预览和续翻检查点，不发布全文。

## 实现与验证

- `worker/translation-team.ts`：团队提示词、开头分派/验收/关闭工具、独立推进调度和任务定义。
- `worker/document-stream.ts`：预览增量重放、重连和最终全文覆盖。
- `worker/subtitle-agent.ts`：共享文件工具、会话管理、上下文压缩及历史单 Agent 定义。
- `worker/document-task.ts`：持久化、累计预算、取消、恢复与原子发布。
- `worker/agent-worker.ts`：新任务默认入口、缓存身份和历史恢复兼容。
- `tests/translation-team.test.ts`：分段覆盖、越界写入、验收关闭、失败隔离、预算和历史兼容。
- `tests/translation-streaming.test.ts`：开头 + 9 路并发、快任务不等慢任务、逐回合保存、独立退避、预览先发/重连/重启/最终替换和取消。
- `tests/extension.test.ts`：预览立即渲染、最终覆盖与导出不重复。

自动化测试使用本地受控模型，不消耗真实外部模型 token；真实速度和翻译质量仍需用实际模型与视频评估。
