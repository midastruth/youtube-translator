# YouTube Subtitle Translator — 轻量浏览器扩展

扩展以严格检查的 TypeScript 维护，浏览器直接执行构建生成的 JavaScript。

```text
extension/
├── src/             background、bridge、content、options 与类型边界
└── public/          manifest、options.html、图标及生成的 JS（加载入口）
```

## 安装与构建

在仓库根目录使用 Node.js（支持 `^22.22.2 || ^24.15.0 || >=26.0.0`）：

```bash
npm run typecheck
make build-extension
# 或 npm run build，同时构建服务端与扩展
```

无需全局安装 TypeScript。`public/*.js`、source maps 与 `dist/` 为构建产物，干净的 checkout 须先执行构建。静态 HTML、manifest 及图标文件保留在 `public/` 目录下。

### Chrome 121+

1. 打开 `chrome://extensions`，开启右上角「开发者模式」。
2. 点击「加载已解压的扩展程序」→ 选择 `extension/public/` 目录。
3. 打开扩展的「选项」页面，配置后端地址（默认 `http://localhost:8787`）和翻译引擎。

### Firefox 128+

1. 打开 `about:debugging#/runtime/this-firefox`。
2. 点击「临时载入附加组件」，选择 `extension/public/manifest.json` 文件。
3. 打开扩展选项页完成设置。

Firefox 临时扩展在浏览器重启后自动移除；长期安装需打包并经 Mozilla 签名。

## 使用与运行

1. **启动后端服务（新产品默认单端口 8787）**：
   本地启动须具备 Node.js 以及系统外部依赖 **`yt-dlp`** 与 **`ffmpeg`**。在仓库根目录执行：
   ```bash
   npm ci --cache ./tmp/npm-cache
   npm start   # 或 make start、docker compose up -d
   ```
   统一 TypeScript 服务端已在进程内集成文档翻译 Worker，监听单一 `8787` 端口，无需多进程跳转。如需配置 YouTube 反爬 Cookie，本地指定 `YTDLP_COOKIES_FILE=./cookies/youtube-cookies.txt`（Docker 容器内为 `/run/secrets/youtube-cookies.txt`）。
2. **选项页设置**：
   - 后端地址：默认填写 `http://localhost:8787`。
   - 翻译引擎：默认为 **全文高质量 (document)** 模式（支持 OpenAI 规范的大模型）；亦可选择 **快速模式 (legacy)**。
   - 模型配置：可在此填入模型 API Key、Base URL 及 Model 名称。设置项保存在浏览器本地扩展存储（`chrome.storage.local`）中，便于日常使用，用户须保护好本机浏览器 profile 安全；服务端与 Worker 任务数据库绝不持久化存储请求中的 API Key。
3. **打开 YouTube 播放视频**：
   点击播放器右下角新增的翻译按钮开启双语字幕；每次刷新页面或 SPA 切换视频时默认处于关闭状态。
4. **功能特性**：
   - 悬浮拖动调整字幕位置，并自动记忆保存。
   - 点击扩展弹窗/图标可直接将当前视频已加载的双语字幕导出为 WebVTT 文件（时间戳严格对齐毫秒）。

### 历史兼容说明 (Legacy)
- 若需要配合旧版独立 Worker 调试，可以在根目录运行 `npm run worker`（默认端口 8788）。
- 旧版 Python FastAPI 后端可通过 `make start-backend` 启动，但已不再是默认运行依赖。

## 开发与验收

修改 `src/*.ts` 后重新运行 `make build-extension`，在 Chrome 扩展页点击重载，或在 Firefox 调试页重载临时扩展，并刷新 YouTube 页面。
根目录 `npm run test:unit` 执行单元测试；`npm test` 还运行原有与迁移 Gherkin 验收，需系统 PATH 包含 Babashka 1.13.225 与 APS `gherkin-parser`。验收套件通过受控 DOM、Chrome API 与网络 mock 执行，不发起真实外部大模型请求。
