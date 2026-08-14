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

### 2. 加载扩展

1. 打开 Chrome → `chrome://extensions`
2. 开启「开发者模式」
3. 「加载已解压的扩展程序」→ 选择 `minimal-extension/public/`
4. 在扩展设置里配置后端地址，默认 `http://localhost:8787`

### 3. 打开 YouTube

打开任意 YouTube 视频 → 双语字幕自动显示。

## 开发

```bash
# 后端测试
cd backend && PYTHONPATH=src python -m unittest discover -s tests -v
```
