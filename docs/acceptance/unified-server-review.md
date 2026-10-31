# Python → TypeScript 统一服务验收

## 结论

本地代码与协议验收通过。默认入口为 `npm start` / `make start`，仅一个对外端口 `8787`，HTTP、SSE、WebSocket 与持久化 AgentWorker 在同一进程内连接。Python 后端保留为历史兼容实现，不再是默认 API 服务运行依赖；`yt-dlp`、`ffmpeg` 仍为外部工具。

未执行付费真实模型质量评测、真实 YouTube 视频在线抓取或浏览器人工安装验收；Docker 守护进程权限不足，未构建或运行镜像。本结论不等同于这些上线环境验收。

## 独立复验结果

在项目根目录运行：

```bash
npm run typecheck
PATH="$PWD/.swarmforge/bin:$PATH" timeout 180s npm run verify
docker compose config --quiet
git diff --check
```

最终复验：

- 类型检查、构建通过，编译产物可独立启动并响应健康检查。
- 单元与集成测试：**207/207**，零失败、零取消、零跳过。
- Gherkin 验收：**75/75 场景、1192/1192 步骤**。
- 属性测试：**8/8**。
- Compose 配置校验通过，默认仅 `server` 与 `pot-provider`，独立 Worker 放入 `legacy` profile。
- `.env` 在临时工作目录中通过真实 Node 子进程加载，缓存与数据库使用临时目录。
- 额外用真实 ffmpeg 将 1.25 秒测试音频切为三个有效音频块。
- 中英文规则与统计断句进行了 240 组固定随机夹具的 Python/TypeScript 差分对照；换算内部秒接口后，文本与时间轴结果一致。

## 不依赖 agent 自报的核心检查

`tests/server-review.test.ts` 为独立编写的 10 项公开接口验收，覆盖：

- REST / SSE / WebSocket 对外始终使用毫秒时间轴。
- 全部与部分翻译失败时，状态、失败数量、进度如实反映结果。
- 非法类型、嵌套字幕字段与超大 JSON 返回客户端错误或 HTTP 413。
- 延迟 SSE 译文正常交付，关闭空闲 WebSocket 不挂起退出。
- 使用真实 WhisperClient、本地 HTTP multipart 端点，验证语言提示、并发转写去重、缓存及毫秒输出。
- 使用真实 AgentWorker、临时 SQLite、本地脚本化 OpenAI-compatible 端点完成全文分析、翻译、审校与发布；再次经 SSE 和 WebSocket 附着同一任务，不重复调用模型、不重复发 meta/source_cue，不将请求密钥写入任务数据库。

其余新增回归覆盖响应 headers 已发送但 body 卡住的超时、缓存嵌套锁、并发维护、SQLite/WAL/锁文件保护、显式 null 配置、参数非法值、端口占用清理、WebSocket `cue_chunk` 与 UTF-8 分片。

## 本轮发现并退回修复的问题

缓存自等待死锁；构建未包含新服务；默认入口仍依赖 Python；秒/毫秒不兼容；翻译失败误报成功；缺少请求校验；超时仅覆盖响应头；Whisper 未集成及参数接口不匹配；清缓存可能删除 Worker 数据库；缺少 WebSocket 兼容与重复事件；启动失败资源泄漏；配置文件不加载；Cookie 目录未排除提交与 Docker build context。修复后重新执行上述验收。

## 保留边界

- `document` 与 `legacy` 支持真实外部模型 API；旧 `agent` 引擎的默认规则/示例实现不代表已产品化的真实模型翻译。
- 测试中的模型端点为受控本地服务，验证真实服务与 Worker 的集成，不证明未见视频的翻译质量。
- 扩展选项中的密钥仍存于 `chrome.storage.local`；不持久化请求密钥的保证针对 Worker 任务数据库，不等于扩展不保存用户配置。
- 改动未自动提交；已有用户改动和历史 Python 源码未删除。
