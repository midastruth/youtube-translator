# YouTube Translator

YouTube 双语字幕翻译系统 — 后端服务 + 轻量浏览器扩展。

```
youtube-translator/
├── backend/             Python FastAPI 后端 (youtube-ingest)
├── minimal-extension/   轻量浏览器扩展
├── docker-compose.yml
├── Makefile
└── README.md
```

## 架构

```
浏览器 (minimal-extension)
  │  调后端 API
  ▼
后端 (youtube-ingest)
  │  yt-dlp → json3 → 断句 → 翻译
  ▼
返回双语字幕 JSON → 扩展渲染到 YouTube 播放器
```

## 快速开始

### 1. 启动后端

```bash
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -e .
cp .env.example .env   # 编辑填入 OPENAI_API_KEY
youtube-ingest-server
```

或 Docker：

```bash
docker compose up -d
```

Docker Compose 会同时启动自动 PO Token Provider，并在后端镜像中启用
Deno/yt-dlp-ejs，以支持 YouTube 当前的 JavaScript 挑战和字幕令牌要求。
如果 YouTube 返回「Sign in to confirm you’re not a bot」，还需要给 yt-dlp
提供浏览器 Cookie（见下方故障排查）。

### YouTube 反爬 / 400 排查

如果扩展显示 `字幕加载失败：Backend 400`，先直接查看后端返回的 `detail`。
当前最常见原因是 yt-dlp 被 YouTube 判定为机器人，而不是翻译 API 错误。

1. 用浏览器 Cookie 导出工具导出 **Netscape cookies.txt**（不要导出 JSON）。
2. 将文件保存为 `backend/cookies/youtube-cookies.txt`。
3. 在项目根目录 `.env` 增加：

```env
YTDLP_COOKIES_FILE=/run/secrets/youtube-cookies.txt
```

4. 重建并重启后端：

```bash
docker compose up -d --build backend
```

Cookie 文件只放本机，不要提交到 Git；YouTube Cookie 失效后需重新导出。

注意：本项目 `.env` 中的 `PORT` 会覆盖 Docker 映射的宿主机端口（默认 `8787`）。
若改了 `PORT`（例如 `8791`），需在扩展设置中填写对应地址 `http://localhost:8791`。

### 浏览器字幕兜底

若后端 yt-dlp 被拦截或找不到字幕轨道，扩展会读取 YouTube 播放器自身加载的
字幕（json3，保留逐词时间），交给后端走同样的断句与翻译流程。该兜底只在后端
无法提供轨道时启用，不会把浏览器 Cookie 发送给后端。

### 2. 构建并加载扩展

在项目根目录安装锁定依赖并构建（Node 22.22.2+、24.15+ 或 26+）：

```bash
npm ci --cache ./tmp/npm-cache
npm run typecheck
make build-extension
```

扩展源码在 `minimal-extension/src/*.ts`；生成的 JS 放在原加载目录，不提交构建产物。
支持 Chrome 121+ 和 Firefox 128+。

- Chrome：打开 `chrome://extensions`，开启「开发者模式」，选择「加载已解压的扩展程序」，然后选择 `minimal-extension/public/`。
- Firefox：打开 `about:debugging#/runtime/this-firefox`，选择「临时载入附加组件」，然后选择 `minimal-extension/public/manifest.json`。

加载后，在扩展设置里配置后端地址，默认 `http://localhost:8787`。

### 3. 打开 YouTube

打开任意 YouTube 视频 → 点击播放器翻译按钮开启双语字幕。首次加载和 SPA 切换视频均默认关闭。

## 开发

所有产品脚本与验收步骤以 TypeScript 维护，Python 后端保持不变。仅需本地 npm 依赖，无需全局 TypeScript。

```bash
npm ci --cache ./tmp/npm-cache
npm run typecheck       # 严格检查 worker、扩展、验收步骤及单元测试
npm run build           # dist/worker/*.js + minimal-extension/public/*.js
npm run worker          # 自行构建并启动真实内部 HTTP 服务
npm run test:unit       # 独立单元测试
npm test                # 单元测试 + 原有和新增 Gherkin 验收
```

worker 默认端口 `8788`，数据库默认 `./cache/worker-storage.db`；可通过
`TRANSLATION_AGENT_PORT`、`TRANSLATION_AGENT_STORAGE` 覆盖。其健康检查为
`GET /internal/health`。构建输出与测试临时目录均被 Git 忽略。

验收管线还需要 Babashka 1.13.225 和 APS 提供的 `gherkin-parser` 在 PATH 中。
SwarmForge 环境可先运行 `swarm_tool.sh require gherkin-parser`，缺失时运行
`swarm_tool.sh ensure gherkin-parser`。`npm run test:acceptance` 顺序执行构建、
APS 解析、Babashka 入口生成及生成的可执行测试；Cucumber 是运行器适配层，
保留原 feature 的数据表（APS IR 目前未携带这些表），并校验场景及 Examples 数量。
测试夹具在 `./tmp/` 隔离真实 HTTP/数据库以及受控 DOM、浏览器 API 与播放器边界，
不请求真实模型，也不声称已在真实浏览器安装验证或证明翻译质量改善。

修改扩展 TS 后重新运行 `make build-extension`，在 Chrome 扩展页点击重载，
或在 Firefox 调试页重载临时扩展，并刷新 YouTube 页面。

```bash
# Python 后端测试（另行安装后端依赖）
cd backend && PYTHONPATH=src python -m unittest discover -s tests -v
```
