"""FastAPI server that provides YouTube subtitle & translation services.

Run with:
    youtube-ingest-server
    uvicorn youtube_ingest.server:app --host 0.0.0.0 --port 8787
"""

from __future__ import annotations

import json
import logging
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any, AsyncGenerator

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from .cache import SubtitleCache
from .errors import IngestError
from .subtitle_processing import (
    FlatEvent,
    builtin_segment,
    prepare_timed_text_events,
)
from .translate import (
    TranslateError,
    translate_stream,
    translate_subtitles,
)
from .youtube import choose_subtitle, fetch_metadata

load_dotenv(dotenv_path=Path.cwd() / ".env")

logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
logger = logging.getLogger("youtube-ingest-server")

# ── cache ──────────────────────────────────────────────────────────────

_cache = SubtitleCache(
    cache_dir=Path(os.getenv("CACHE_DIR", Path.cwd() / "cache")),
    ttl_seconds=float(os.getenv("CACHE_TTL_SECONDS", "86400")),
)


# ── yt-dlp helpers ─────────────────────────────────────────────────────

def _run_yt_dlp(args: list[str]) -> str:
    command = [sys.executable, "-m", "yt_dlp", *args]
    try:
        result = subprocess.run(
            command, check=True, text=True,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )
    except subprocess.CalledProcessError as exc:
        detail = (exc.stderr or exc.stdout or str(exc)).strip()
        raise IngestError(f"yt-dlp failed: {detail}") from exc
    return result.stdout.strip()


def _fetch_json3_subtitle(url: str, language: str) -> str | None:
    """Download a single subtitle track as YouTube json3 (timedtext)."""
    with tempfile.TemporaryDirectory() as tmpdir:
        out_tmpl = os.path.join(tmpdir, "sub")
        args = [
            "--skip-download",
            "--write-sub",
            "--write-auto-sub",
            "--sub-langs", language,
            "--sub-format", "json3",
            "--output", out_tmpl,
            "--no-warnings",
            url,
        ]
        _run_yt_dlp(args)
        candidates = sorted(Path(tmpdir).glob("sub*.json3"))
        if not candidates:
            return None
        return Path(candidates[0]).read_text(encoding="utf-8")


def _download_audio(url: str, dest_dir: Path) -> Path:
    """Download best audio, convert to mp3.  Returns path."""
    dest_dir.mkdir(parents=True, exist_ok=True)
    template = str(dest_dir / "audio.%(ext)s")
    output = _run_yt_dlp([
        "--format", "bestaudio/best",
        "--extract-audio",
        "--audio-format", "mp3",
        "--audio-quality", "5",
        "--output", template,
        "--print", "after_move:filepath",
        "--no-warnings",
        url,
    ])
    reported = [Path(line) for line in output.splitlines() if line.strip()]
    for path in reversed(reported):
        if path.exists():
            return path
    candidates = sorted(dest_dir.glob("audio.*"))
    if not candidates:
        raise IngestError("yt-dlp did not produce an audio file")
    return candidates[0]


# ── Pydantic models ────────────────────────────────────────────────────

class SubtitleTrack(BaseModel):
    language: str
    source: str  # "manual" | "automatic"
    label: str


class SubtitleRequest(BaseModel):
    url: str
    language: str | None = None
    languages: list[str] = ["zh-Hans", "zh-Hant", "zh", "en"]
    allow_automatic: bool = True
    segmentation: str = "rule"  # "rule" | "statistical"
    translate_to: str | None = None
    translate_provider: str = "openai"
    translate_api_key: str | None = None
    translate_base_url: str | None = None
    translate_model: str | None = None
    translate_whole: bool = False  # True = 全文一次性翻译，保证术语/上下文一致


class SubtitleCue(BaseModel):
    start: float
    end: float
    text: str
    translation: str = ""


class SubtitleResponse(BaseModel):
    video_id: str
    title: str
    from_lang: str
    to_lang: str | None
    segmentation: str
    source: str  # "manual" | "automatic" | "whisper"
    cues: list[SubtitleCue] = []
    progress: int = 100


class TracksResponse(BaseModel):
    video_id: str
    title: str
    tracks: list[SubtitleTrack] = []


class HealthResponse(BaseModel):
    status: str = "ok"
    version: str = "0.2.0"


# ── App ────────────────────────────────────────────────────────────────

app = FastAPI(
    title="YouTube Ingest & Translate",
    description="Backend service providing YouTube subtitle extraction, "
    "intelligent sentence breaking, and translation for kiss-translator.",
    version="0.2.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── core logic (shared) ────────────────────────────────────────────────

def _process_subtitle_sync(
    url: str,
    languages: list[str],
    allow_automatic: bool,
    segmentation: str,
) -> tuple[dict, list[dict]]:
    """Shared sync portion: fetch metadata, pick track, download & segment.

    Returns (meta_dict, cues_list).
    """
    # Metadata
    metadata = fetch_metadata(url)
    video_id = str(metadata.get("id") or "unknown")
    title = str(metadata.get("title") or video_id)

    # Select track
    selected = choose_subtitle(metadata, languages, allow_automatic)
    if selected is None:
        raise HTTPException(status_code=404, detail="No matching subtitle track found")
    lang, source = selected
    logger.info("Selected subtitle: %s (%s)", lang, source)

    # Try cache for processed cues first (without translation)
    cached = _cache.get_cues(video_id, lang, segmentation, None)
    if cached:
        logger.info("Cache hit for %s/%s/%s", video_id, lang, segmentation)
        return {
            "video_id": video_id, "title": title,
            "from_lang": lang, "source": source,
        }, cached

    # Download json3
    json3_text = _cache.get_json3(video_id, lang)
    if json3_text is None:
        json3_text = _fetch_json3_subtitle(url, lang)
        if json3_text is None:
            raise HTTPException(status_code=500, detail="Failed to download subtitle")
        _cache.put_json3(video_id, lang, json3_text)

    try:
        json3_data = json.loads(json3_text)
    except json.JSONDecodeError:
        raise HTTPException(status_code=500, detail="Invalid subtitle JSON")

    raw_events = json3_data.get("events") or []

    # Process
    prepared = prepare_timed_text_events(raw_events)
    events = prepared["events"]
    flat_events = prepared["flat_events"]
    logger.info(
        "Prepared %d events, %d flat events, filtered %d non-speech",
        len(events), len(flat_events), prepared["filtered_non_speech_count"],
    )

    if not flat_events:
        raise HTTPException(status_code=404, detail="No usable subtitle text found")

    # Segment
    cues = builtin_segment(events, flat_events, from_lang=lang, mode=segmentation)
    logger.info("Segmented into %d cues (mode=%s)", len(cues), segmentation)

    # Cache
    _cache.put_cues(video_id, lang, segmentation, None, cues)

    return {
        "video_id": video_id, "title": title,
        "from_lang": lang, "source": source,
    }, cues


# ── REST endpoints ─────────────────────────────────────────────────────

@app.get("/api/health", response_model=HealthResponse)
async def health():
    return HealthResponse()


@app.get("/api/subtitle/tracks", response_model=TracksResponse)
async def get_tracks(
    url: str = Query(..., description="YouTube video URL"),
    languages: str = Query("zh-Hans,zh-Hant,zh,en"),
):
    """List available subtitle tracks for a YouTube video."""
    try:
        lang_list = [l.strip() for l in languages.split(",") if l.strip()]
        metadata = fetch_metadata(url)
        video_id = str(metadata.get("id") or "unknown")
        title = str(metadata.get("title") or video_id)

        tracks: list[SubtitleTrack] = []
        for src_name, src_label in [("subtitles", "manual"), ("automatic_captions", "automatic")]:
            available = metadata.get(src_name) or {}
            for lang_code in available:
                if lang_code.lower()[:2] in {l.lower()[:2] for l in lang_list}:
                    tracks.append(SubtitleTrack(
                        language=lang_code,
                        source=src_label,
                        label=f"{lang_code}" + (" (auto)" if src_label == "automatic" else ""),
                    ))
        return TracksResponse(video_id=video_id, title=title, tracks=tracks)
    except IngestError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        logger.exception("Failed to fetch tracks")
        raise HTTPException(status_code=500, detail=str(exc))


@app.post("/api/subtitle/process", response_model=SubtitleResponse)
async def process_subtitle(req: SubtitleRequest):
    """Fetch subtitle, segment, and optionally translate."""
    try:
        meta, cues = _process_subtitle_sync(
            url=req.url,
            languages=req.languages,
            allow_automatic=req.allow_automatic,
            segmentation=req.segmentation,
        )

        # Translate if requested
        to_lang = req.translate_to
        if to_lang and cues:
            try:
                cues = await translate_subtitles(
                    cues, from_lang=meta["from_lang"], to_lang=to_lang,
                    provider=req.translate_provider,
                    api_key=req.translate_api_key,
                    base_url=req.translate_base_url,
                    model=req.translate_model,
                    whole=req.translate_whole,
                )
            except Exception as exc:
                logger.warning("Translation failed, returning untranslated cues: %s", exc)

        return SubtitleResponse(
            video_id=meta["video_id"],
            title=meta["title"],
            from_lang=meta["from_lang"],
            to_lang=to_lang,
            segmentation=req.segmentation,
            source=meta["source"],
            cues=[SubtitleCue(**c) for c in cues],
        )
    except IngestError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Failed to process subtitle")
        raise HTTPException(status_code=500, detail=str(exc))


@app.post("/api/subtitle/stream")
async def process_subtitle_stream(req: SubtitleRequest):
    """Fetch + segment subtitles, stream back translation chunks as SSE.

    Each SSE event is a JSON object:
        {"type": "meta", "video_id": ..., "title": ..., ...}
        {"type": "cue", "index": 0, "text": "...", "translation": "..."}
        {"type": "done"}

    The client can render cues incrementally as translations arrive.
    """
    try:
        meta, cues = _process_subtitle_sync(
            url=req.url,
            languages=req.languages,
            allow_automatic=req.allow_automatic,
            segmentation=req.segmentation,
        )
    except HTTPException as exc:
        raise
    except IngestError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        logger.exception("Failed to process subtitle")
        raise HTTPException(status_code=500, detail=str(exc))

    to_lang = req.translate_to
    if not to_lang or not cues:
        # No translation — return all cues at once
        async def _no_translate():
            yield f"data: {json.dumps({'type': 'meta', **meta, 'to_lang': None, 'segmentation': req.segmentation}, ensure_ascii=False)}\n\n"
            for i, c in enumerate(cues):
                yield f"data: {json.dumps({'type': 'cue', 'index': i, **c}, ensure_ascii=False)}\n\n"
            yield "data: {\"type\":\"done\"}\n\n"
        return StreamingResponse(_no_translate(), media_type="text/event-stream")

    # Stream translate
    async def _event_stream():
        yield f"data: {json.dumps({'type': 'meta', **meta, 'to_lang': to_lang, 'segmentation': req.segmentation}, ensure_ascii=False)}\n\n"

        for idx, cue in enumerate(cues):
            text = cue["text"]
            if not text.strip():
                yield f"data: {json.dumps({'type': 'cue', 'index': idx, **cue}, ensure_ascii=False)}\n\n"
                continue

            # Stream this cue's translation
            translation_parts: list[str] = []
            try:
                async for chunk in translate_stream(
                    text, from_lang=meta["from_lang"], to_lang=to_lang,
                    provider=req.translate_provider,
                    api_key=req.translate_api_key,
                    base_url=req.translate_base_url,
                    model=req.translate_model,
                ):
                    translation_parts.append(chunk)
                    partial = "".join(translation_parts)
                    yield f"data: {json.dumps({'type': 'cue_chunk', 'index': idx, 'text': text, 'translation': partial}, ensure_ascii=False)}\n\n"

                full = "".join(translation_parts)
                cue["translation"] = full
            except Exception as exc:
                logger.warning("Stream translate failed for cue %d: %s", idx, exc)
                cue["translation"] = "[Translation failed]"

            yield f"data: {json.dumps({'type': 'cue', 'index': idx, **cue}, ensure_ascii=False)}\n\n"

        yield "data: {\"type\":\"done\"}\n\n"

    return StreamingResponse(_event_stream(), media_type="text/event-stream")


# ── WebSocket ──────────────────────────────────────────────────────────

@app.websocket("/ws/subtitle/process")
async def ws_subtitle_process(ws: WebSocket):
    """WebSocket endpoint — same as /api/subtitle/process but over WS.

    Client sends JSON request, server streams back response with partial cues.
    """
    await ws.accept()
    try:
        raw = await ws.receive_text()
        req = SubtitleRequest.parse_raw(raw)
    except (WebSocketDisconnect, ValueError) as exc:
        await ws.close(code=1003, reason=str(exc))
        return

    try:
        meta, cues = _process_subtitle_sync(
            url=req.url,
            languages=req.languages,
            allow_automatic=req.allow_automatic,
            segmentation=req.segmentation,
        )
    except Exception as exc:
        await ws.send_json({"type": "error", "detail": str(exc)})
        await ws.close()
        return

    # Send meta
    to_lang = req.translate_to
    await ws.send_json({
        "type": "meta",
        **meta,
        "to_lang": to_lang,
        "segmentation": req.segmentation,
        "total_cues": len(cues),
    })

    if to_lang and cues:
        for idx, cue in enumerate(cues):
            text = cue["text"]
            if not text.strip():
                await ws.send_json({"type": "cue", "index": idx, **cue})
                continue

            translation_parts: list[str] = []
            try:
                async for chunk in translate_stream(
                    text, from_lang=meta["from_lang"], to_lang=to_lang,
                    provider=req.translate_provider,
                    api_key=req.translate_api_key,
                    base_url=req.translate_base_url,
                    model=req.translate_model,
                ):
                    translation_parts.append(chunk)
                    await ws.send_json({
                        "type": "cue_chunk",
                        "index": idx,
                        "text": text,
                        "translation": "".join(translation_parts),
                    })

                cue["translation"] = "".join(translation_parts)
            except Exception as exc:
                logger.warning("WS translate failed for cue %d: %s", idx, exc)
                cue["translation"] = "[Translation failed]"

            await ws.send_json({"type": "cue", "index": idx, **cue})
    else:
        for idx, cue in enumerate(cues):
            await ws.send_json({"type": "cue", "index": idx, **cue})

    await ws.send_json({"type": "done"})
    # Keep connection open briefly for client to ack, then close
    try:
        await ws.receive_text()  # wait for client ack
    except WebSocketDisconnect:
        pass
    await ws.close()


# ── Cache admin ────────────────────────────────────────────────────────

@app.delete("/api/cache/{video_id}")
async def clear_cache(video_id: str):
    """Clear cache for a specific video."""
    removed = _cache.clear_video(video_id)
    return {"removed": removed}


@app.post("/api/cache/purge")
async def purge_cache():
    """Purge all expired cache entries."""
    removed = _cache.purge_expired()
    return {"removed": removed}


# ── Entry point ────────────────────────────────────────────────────────

def main():
    """Entry point for `youtube-ingest-server` console script."""
    import uvicorn
    uvicorn.run(
        "youtube_ingest.server:app",
        host=os.getenv("HOST", "0.0.0.0"),
        port=int(os.getenv("PORT", "8787")),
        reload=bool(os.getenv("RELOAD", "")),
    )
