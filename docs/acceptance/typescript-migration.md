# JS → TS 迁移验收范围

任务：`tasks/把js 改为ts.md`（原始意图：把 js 改为 ts）。

## 范围

迁移当前产品中全部手写 JavaScript，包括：

- `worker/` 的 11 个模块：agent-worker、chunker、keys、network、quality-eval、reviewer、server、storage、task-definition、tools、validator。
- `minimal-extension/public/` 中的 background、bridge、content、options 脚本。
- `features/step_definitions/steps.js` 及本任务新增的验收步骤。

以上逻辑以 `.ts` 为唯一维护源，不保留一套手写 JS 副本；源码位置和构建工具由实现选择。浏览器仍执行构建生成的 JavaScript，并非把 manifest 的脚本后缀改为 `.ts`。Python 后端不改语言；依赖、构建产物、SwarmForge 基础设施不在迁移范围内。

## 开发者契约

- 从干净 checkout 执行 `npm ci` 后，提供 `npm run typecheck` 和 `npm run build`。所有产品 TS 和验收步骤都参与严格类型检查；不能靠排除模块、整文件关闭检查、全面使用 `any` 或双重断言绕过迁移。外部动态数据允许在边界使用 `unknown` 并收窄。
- `npm run build` 产生可运行 worker 和扩展；`npm run worker` 保留启动入口和原环境变量语义，允许自行构建，不依赖提交的旧 JS 或全局 TS 工具。
- `npm test`、`npm run test:acceptance` 保留已有验收场景，并执行新增迁移验收；不得通过跳过场景、改写预期或仅扫描文件来宣称运行时兼容。
- `make build-extension` 完成真实构建。现有 Chrome 加载目录 `minimal-extension/public/` 和 Firefox manifest 路径保持可用，静态 HTML、图标及跨浏览器配置仍包含在该目录。
- 更新根目录和扩展开发说明，明确安装、类型检查、构建、启动及扩展重载步骤。构建产物和缓存不作为手写源码提交。

## 行为与边界

迁移不增加翻译功能，不改变 API 字段、字幕毫秒时间轴、引擎默认值、存储格式、job key 算法或扩展设置的存储键。保留现有依赖锁定版本。TS 暴露的原有错误可以做最小修正，例如 `worker/server.js` 的快照分支当前引用了未导入的 `SubtitleJobDoc`；不要借此重新设计任务工作流。

配套规格：

- `typescript-toolchain.feature`：源码范围、干净构建、严格类型检查。
- `typescript-worker.feature`：启动、HTTP 快照/流、冻结缓存键。
- `typescript-extension.feature`：浏览器加载入口、设置、字幕/VTT、开关和播放器兜底。

只使用 APS 支持的声明、步骤和 Examples，不扩展旧翻译质量规格的产品承诺。

## 验收连接要求

- 命令场景运行实际项目命令，类型错误测试在 `./tmp/` 的隔离项目副本中进行，并确认错误来自被检查的迁移类型，不是启动失败或缺少依赖。
- worker 场景使用真实 Node HTTP 服务和临时持久化存储，模型调用使用现有脚本化模型边界；进程与存储在场景后清理。
- 扩展场景执行构建产物，在受控 DOM、Chrome API、fetch/播放器边界下验证真实脚本的副作用；不在测试步骤里重新实现设置保存、请求构造、字幕合并或 VTT 导出。边界隔离测试不声称已经做了真实浏览器安装验证。
- 旧验收在当前 JS 基线为 53 场景、761 步骤通过；其中部分断言是 mock 或空断言，不能将这个数量当作完整真实模型质量或恢复能力的证明。本任务不借迁移重写这些既有产品契约。
