# youtube-ingest

YouTube 字幕获取、智能分句、翻译后端服务。

```
浏览器 (minimal-extension)
        │
        │ HTTP
        ▼
┌─────────────────────────────────────────┐
│         youtube-ingest (FastAPI)         │
│                                          │
│  GET  /api/health                        │
│  GET  /api/subtitle/tracks?url=...       │
│  POST /api/subtitle/process              │
│  POST /api/subtitle/stream      (SSE)    │
│  WS   /ws/subtitle/process               │
│  DELETE /api/cache/{video_id}            │
│  POST /api/cache/purge                   │
│                                          │
│  内部流水线:                               │
│    yt-dlp → json3 → 清洗展平 → 断句 → 翻译  │
│                                          │
│  断句模式:                                 │
│    "rule"        — 基于标点/停顿的内置规则   │
│    "statistical" — Z-Score + MAD 统计算法  │
│                                          │
│  翻译模式:                                 │
│    逐句并行  — translate_batch            │
│    全文一次  — translate_whole (术语统一)  │
│    流式逐词  — translate_stream (SSE/WS)  │
└─────────────────────────────────────────┘
```

## 环境要求

- Python 3.10+
- `ffmpeg`（Whisper 兜底时需要）
- Docker（可选部署方式）

## 安装

```bash
pip install -e .
cp .env.example .env
```

配置 `.env`：

```env
OPENAI_API_KEY=sk-...
```

## 使用

### 启动服务

```bash
youtube-ingest-server
# 或:
uvicorn youtube_ingest.server:app --host 0.0.0.0 --port 8787
```

### Docker

```bash
docker compose up -d
```

### API 示例

```bash
# 获取可用字幕轨道
curl "http://localhost:8787/api/subtitle/tracks?url=https://www.youtube.com/watch?v=VIDEO_ID"

# 获取双语字幕（统计断句 + 全文翻译）
curl -X POST http://localhost:8787/api/subtitle/process \
  -H 'Content-Type: application/json' \
  -d '{
    "url": "https://www.youtube.com/watch?v=VIDEO_ID",
    "languages": ["en"],
    "segmentation": "statistical",
    "translate_to": "zh-CN",
    "translate_whole": true
  }'

# SSE 流式
curl -N -X POST http://localhost:8787/api/subtitle/stream \
  -H 'Content-Type: application/json' \
  -d '{"url":"...","languages":["en"],"translate_to":"zh-CN"}'

# WebSocket
websocat ws://localhost:8787/ws/subtitle/process
```

### CLI 模式（离线转录）

```bash
youtube-ingest "https://www.youtube.com/watch?v=VIDEO_ID" \
  --languages "zh-Hans,zh-Hant,zh,en" \
  --output-dir output
```

## 测试

```bash
PYTHONPATH=src python -m unittest discover -s tests -v
```
