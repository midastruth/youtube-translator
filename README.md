# YouTube Translator

双语字幕翻译系统 — 包含后端服务 + 浏览器扩展。

```
youtube-translator/
├── backend/          Python FastAPI 后端 (youtube-ingest)
├── extension/        浏览器扩展 (kiss-translator)
├── docker-compose.yml
├── Makefile
└── README.md
```

## 架构

```
浏览器 (kiss-translator 扩展)
  │  backendUrl = "http://localhost:8787"
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

### 2. 加载浏览器扩展

1. 打开 Chrome → `chrome://extensions`
2. 开启「开发者模式」
3. 「加载已解压的扩展程序」→ 选择 `extension/` 目录
4. 在扩展设置里找到字幕设置，填入 `backendUrl: "http://localhost:8787"`

### 3. 打开 YouTube

打开任意 YouTube 视频 → 字幕自动以双语显示。

## 开发

```bash
# 后端测试
cd backend && PYTHONPATH=src python -m unittest discover -s tests -v

# 扩展构建
cd extension && pnpm install && pnpm build
```
