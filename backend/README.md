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
│  DELETE /api/cache                       │
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

### 缓存保留策略

默认缓存目录是 `cache/`。成本较高的分段结果、翻译结果和 Whisper
转写不会按时间过期；它们只会在缓存版本变化、手动删除或缓存超过
5 GiB 时按最近最少使用顺序淘汰。元数据保留 24 小时，原始字幕保留
30 天。

```env
CACHE_METADATA_TTL_SECONDS=86400
CACHE_JSON3_TTL_SECONDS=2592000
CACHE_CUES_TTL_SECONDS=0
CACHE_TRANSLATION_TTL_SECONDS=0
CACHE_WHISPER_TTL_SECONDS=0
CACHE_MAX_BYTES=5368709120
CACHE_MAINTENANCE_INTERVAL_SECONDS=86400
```

`0` 表示不按时间过期。旧的 `CACHE_TTL_SECONDS` 仍兼容，但一旦设置，
会覆盖所有分类型 TTL。缓存写入是原子的；服务启动时和运行期间会自动
清理过期文件并执行容量限制。

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

若 `/api/subtitle/tracks` 返回 400，且 detail 包含
`Sign in to confirm you’re not a bot`，请从浏览器导出 Netscape 格式的
`cookies.txt`，保存到 `backend/cookies/youtube-cookies.txt`，并在项目根目录
`.env` 设置：

```env
YTDLP_COOKIES_FILE=/run/secrets/youtube-cookies.txt
```

Compose 会把 `backend/cookies/` 只读挂载到 `/run/secrets/`。然后执行：

```bash
docker compose up -d --build backend
```

Cookie 是敏感凭据，不要提交到 Git。

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
