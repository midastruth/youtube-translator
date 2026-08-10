# youtube-ingest

YouTube 字幕获取、智能分句、翻译后端服务 — 为 kiss-translator 提供后端支撑。

```
浏览器 (kiss-translator + YouTubeBackendProvider)
        │
        │ HTTP / SSE / WebSocket
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
│  翻译后端: OpenAI / DeepL                 │
└─────────────────────────────────────────┘
```

## 环境要求

- Python 3.10+
- `ffmpeg`（Whisper 兜底时需要）
- Docker（可选部署方式）

## 安装

```bash
cd youtube-ingest
python -m venv .venv
source .venv/bin/activate
python -m pip install -e .
```

配置 `.env`：

```env
# 翻译（可选，不设置就不会翻译）
OPENAI_API_KEY=sk-...
OPENAI_BASE_URL=https://api.openai.com/v1

# 缓存
CACHE_DIR=./cache
CACHE_TTL_SECONDS=86400
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

# 获取双语字幕（带翻译）
curl -X POST http://localhost:8787/api/subtitle/process \
  -H 'Content-Type: application/json' \
  -d '{
    "url": "https://www.youtube.com/watch?v=VIDEO_ID",
    "languages": ["en", "zh-Hans"],
    "segmentation": "statistical",
    "translate_to": "zh-CN",
    "translate_provider": "openai"
  }'

# SSE 流式（逐句推送翻译）
curl -N -X POST http://localhost:8787/api/subtitle/stream \
  -H 'Content-Type: application/json' \
  -d '{
    "url": "https://www.youtube.com/watch?v=VIDEO_ID",
    "languages": ["en"],
    "segmentation": "rule",
    "translate_to": "zh-CN"
  }'

# WebSocket（实时双向）
websocat ws://localhost:8787/ws/subtitle/process
# 发送 JSON 请求，接收流式 cues
```

### CLI 模式（离线转录）

```bash
youtube-ingest "https://www.youtube.com/watch?v=VIDEO_ID" \
  --languages "zh-Hans,zh-Hant,zh,en" \
  --output-dir output
```

## 在前端使用

```javascript
import { YouTubeBackendProvider } from "youtube-ingest/frontend_adapter.js";

const provider = new YouTubeBackendProvider({
  backendUrl: "http://localhost:8787",
  videoEl: document.querySelector("video"),
  setting: {
    autoTranslate: true,
    segmentation: "statistical",
    toLang: "zh-CN",
    translateProvider: "openai",
    translateApiKey: "sk-...",
  },
  // 传入 kiss-translator 渲染器:
  BilingualSubtitleManager,
  YouTubeSubtitleList,
});

await provider.initialize();
// 双语字幕自动渲染到播放器上
```

## 项目结构

```
src/youtube_ingest/
├── server.py                       # FastAPI 服务 (8 端点)
├── subtitle_processing.py          # 字幕清洗、展平、断句（规则+统计算法）
├── subtitle_text_classification.py # 非语音片段识别
├── translate.py                    # 翻译客户端（OpenAI/DeepL，支持流式）
├── cache.py                        # 磁盘缓存层
├── youtube.py                      # yt-dlp 封装
├── audio.py                        # ffmpeg 音频切割
├── transcribe.py                   # Whisper API 客户端
├── pipeline.py                     # 离线 CLI 流水线
├── cli.py                          # 命令行入口
├── errors.py                       # 错误类型
├── frontend_adapter.js             # kiss-translator 前端适配器
└── __init__.py

tests/
├── test_subtitle_processing.py     # 断句算法测试 (29 个)
├── test_youtube.py                 # 字幕选择 + VTT 测试
└── test_cli.py                     # CLI 测试

Dockerfile                          # Docker 镜像
docker-compose.yml                  # Docker Compose 部署
```

## 测试

```bash
PYTHONPATH=src python -m unittest discover -s tests -v
```
