# YouTube Subtitle Translator — 轻量扩展

扩展以严格检查的 TypeScript 维护，浏览器执行构建生成的 JavaScript。

```text
minimal-extension/
├── src/             background、bridge、content、options 与类型边界
└── public/          manifest、options.html、图标及生成的 JS（加载入口）
```

## 安装与构建

在仓库根目录使用 Node 22.22.2+、24.15+ 或 26+：

```bash
npm ci --cache ./tmp/npm-cache
npm run typecheck
make build-extension
# 或 npm run build，同时构建 worker
```

不需要全局 TypeScript。`public/*.js`、source maps 与 `dist/` 均为被忽略的生成产物，
干净 checkout 必须先构建。静态 HTML、manifest、图标继续保留在 `public/`。

### Chrome 121+

1. 打开 `chrome://extensions`，开启「开发者模式」。
2. 「加载已解压的扩展程序」→ 选择 `minimal-extension/public/`。
3. 打开扩展的「选项」页面，配置后端地址和翻译引擎。

### Firefox 128+

1. 打开 `about:debugging#/runtime/this-firefox`。
2. 点击「临时载入附加组件」，选择 `minimal-extension/public/manifest.json`。
3. 打开扩展的「选项」页面完成设置。

Firefox 临时扩展在重启后移除；长期安装需要打包并经 Mozilla 签名。

## 使用与开发

1. 启动 Python 后端：`make start` 或 `docker compose up -d`。
2. 选项页填写后端地址（默认 `http://localhost:8787`），可选填入模型配置；
   选择 Agent 时另运行根目录 `npm run worker`。worker 默认端口 8788，
   可设置 `TRANSLATION_AGENT_PORT` 与 `TRANSLATION_AGENT_STORAGE`。
3. 打开 YouTube 视频，点击播放器翻译按钮开启字幕；每次页面加载或切换视频默认关闭。
4. 扩展图标可导出已加载的双语 WebVTT；拖动字幕可调整并保存显示位置。

修改 `src/*.ts` 后重新运行 `make build-extension`，在 Chrome 扩展页重载，
或在 Firefox 调试页重载临时扩展，再刷新 YouTube。
根目录 `npm run test:unit` 执行单元测试；`npm test` 还运行原有与迁移 Gherkin 验收，
需安装 Babashka 与 APS `gherkin-parser`（见根目录 README）。验收执行真实构建脚本，
以受控 DOM、Chrome API、fetch 和播放器边界执行生成脚本；不是实际浏览器安装测试。
