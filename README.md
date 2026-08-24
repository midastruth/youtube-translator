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

注意：本项目 `.env` 中的 `PORT` 会覆盖映射端口。若使用 Docker，扩展后端地址
应填写实际宿主机端口，例如 `http://localhost:8791`，而不是默认的 `8787`。

### 2. 加载扩展

支持 Chrome 121+ 和 Firefox 128+。

- Chrome：打开 `chrome://extensions`，开启「开发者模式」，选择「加载已解压的扩展程序」，然后选择 `minimal-extension/public/`。
- Firefox：打开 `about:debugging#/runtime/this-firefox`，选择「临时载入附加组件」，然后选择 `minimal-extension/public/manifest.json`。

加载后，在扩展设置里配置后端地址，默认 `http://localhost:8787`。

### 3. 打开 YouTube

打开任意 YouTube 视频 → 双语字幕自动显示。

## 开发

```bash
# 后端测试
cd backend && PYTHONPATH=src python -m unittest discover -s tests -v
```
