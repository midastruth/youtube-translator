"""FastAPI server that provides YouTube subtitle & translation services.

Run with:
    youtube-ingest-server
    uvicorn youtube_ingest.server:app --host 0.0.0.0 --port 8787
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import re
import subprocess
import tempfile
import threading
from pathlib import Path
from typing import Any, AsyncGenerator
from urllib.parse import parse_qs, urlparse

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from starlette.concurrency import run_in_threadpool

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
from .youtube import build_yt_dlp_command, choose_subtitle, fetch_metadata

load_dotenv(dotenv_path=Path.cwd() / ".env")

logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
logger = logging.getLogger("youtube-ingest-server")

# ── cache ──────────────────────────────────────────────────────────────

_legacy_cache_ttl = (os.getenv("CACHE_TTL_SECONDS") or "").strip()
_cache_options: dict[str, Any] = {
    "max_bytes": int(os.getenv("CACHE_MAX_BYTES", str(5 * 1024 * 1024 * 1024))),
    "maintenance_interval_seconds": float(
        os.getenv("CACHE_MAINTENANCE_INTERVAL_SECONDS", "86400")
    ),
}
if _legacy_cache_ttl:
    # Preserve deployments that intentionally configured the old single TTL.
    _cache_options["ttl_seconds"] = float(_legacy_cache_ttl)
else:
    _cache_options.update({
        "metadata_ttl_seconds": float(
            os.getenv("CACHE_METADATA_TTL_SECONDS", "86400")
        ),
        "json3_ttl_seconds": float(
            os.getenv("CACHE_JSON3_TTL_SECONDS", str(30 * 86400))
        ),
        # Zero means retained until version invalidation or LRU eviction.
        "cues_ttl_seconds": float(os.getenv("CACHE_CUES_TTL_SECONDS", "0")),
        "translation_ttl_seconds": float(
            os.getenv("CACHE_TRANSLATION_TTL_SECONDS", "0")
        ),
        "whisper_ttl_seconds": float(os.getenv("CACHE_WHISPER_TTL_SECONDS", "0")),
    })

_cache = SubtitleCache(
    cache_dir=Path(os.getenv("CACHE_DIR", Path.cwd() / "cache")),
    **_cache_options,
)
_active_sse_jobs: set[str] = set()
_whisper_locks_guard = threading.Lock()
_whisper_locks: dict[str, threading.Lock] = {}
_SEGMENTATION_CACHE_VERSION = "segment-v1"
_WHISPER_CACHE_VERSION = "whisper-timed-v1"
_TRANSLATION_CACHE_VERSION = "translation-v2"


def _whisper_cache_profile(
    language: str | None,
    base_url: str | None,
    model: str | None,
) -> str:
    """Build a stable cache key without exposing provider URLs in filenames."""
    effective_language = language or "auto"
    effective_base_url = (
        base_url
        or os.getenv("WHISPER_BASE_URL")
        or "https://api.groq.com/openai/v1"
    ).rstrip("/")
    effective_model = model or os.getenv("WHISPER_MODEL") or "whisper-large-v3"
    material = "\n".join((
        _WHISPER_CACHE_VERSION,
        effective_language,
        effective_base_url,
        effective_model,
    ))
    digest = hashlib.sha256(material.encode("utf-8")).hexdigest()[:16]
    safe_language = re.sub(r"[^A-Za-z0-9._-]+", "_", effective_language)
    return f"whisper-{safe_language}-{digest}"


def _whisper_lock(key: str) -> threading.Lock:
    with _whisper_locks_guard:
        return _whisper_locks.setdefault(key, threading.Lock())


def _metadata_cache_profile() -> str:
    """Return a cache namespace for the active yt-dlp YouTube settings.

    Subtitle availability can differ by YouTube player client.  Include the
    client/provider configuration in metadata cache keys so changing from
    mweb to android,mweb cannot keep serving an old empty track list.
    """
    client = os.getenv("YTDLP_YOUTUBE_CLIENT", "").strip()
    provider = os.getenv("YTDLP_POT_PROVIDER_URL", "").strip().rstrip("/")
    if not client and not provider:
        return ""
    material = f"metadata-v2\n{client}\n{provider}"
    return hashlib.sha256(material.encode("utf-8")).hexdigest()[:16]


def _metadata_cache_key(url: str) -> str:
    """Use the YouTube video id when possible, with a stable URL fallback."""
    parsed = urlparse(url)
    host = parsed.netloc.lower().split(":", 1)[0]
    video_id = ""
    if host in {"youtu.be", "www.youtu.be"}:
        video_id = parsed.path.strip("/").split("/", 1)[0]
    elif host.endswith("youtube.com"):
        if parsed.path.rstrip("/") == "/watch":
            video_id = (parse_qs(parsed.query).get("v") or [""])[0]
        else:
            parts = [part for part in parsed.path.split("/") if part]
            if len(parts) >= 2 and parts[0] in {"embed", "live", "shorts"}:
                video_id = parts[1]
    if re.fullmatch(r"[A-Za-z0-9_-]{6,64}", video_id):
        return video_id
    digest = hashlib.sha256(url.strip().encode("utf-8")).hexdigest()[:24]
    return f"url-{digest}"


def _fetch_metadata_cached(url: str) -> dict[str, Any]:
    cache_key = _metadata_cache_key(url)
    profile = _metadata_cache_profile()
    if profile:
        cache_key = f"{cache_key}-metadata-{profile}"
    cached = _cache.get_metadata(cache_key)
    if isinstance(cached, dict):
        return cached
    metadata = fetch_metadata(url)
    _cache.put_metadata(cache_key, metadata)
    return metadata


def _translation_cache_profile(
    cues: list[dict],
    *,
    provider: str,
    base_url: str | None,
    model: str | None,
    strategy: str,
) -> str:
    """Version translations by their inputs without storing provider URLs."""
    effective_provider = provider.lower().strip()
    if effective_provider == "openai":
        effective_base_url = (
            base_url
            or os.getenv("OPENAI_BASE_URL")
            or "https://api.openai.com/v1"
        ).rstrip("/")
        effective_model = model or "gpt-3.5-turbo"
    elif effective_provider == "deepl":
        effective_base_url = "https://api-free.deepl.com/v2"
        effective_model = model or "default"
    else:
        effective_base_url = (base_url or "default").rstrip("/")
        effective_model = model or "default"

    source_cues = [
        {
            "start": cue.get("start"),
            "end": cue.get("end"),
            "text": cue.get("text", ""),
        }
        for cue in cues
    ]
    material = json.dumps(
        {
            "version": _TRANSLATION_CACHE_VERSION,
            "provider": effective_provider,
            "endpoint": effective_base_url,
            "model": effective_model,
            "strategy": strategy,
            "source_cues": source_cues,
        },
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    digest = hashlib.sha256(material.encode("utf-8")).hexdigest()[:24]
    return f"{_TRANSLATION_CACHE_VERSION}-{digest}"


def _cached_translation(
    *,
    video_id: str,
    from_lang: str,
    segmentation: str,
    to_lang: str,
    cues: list[dict],
    provider: str,
    base_url: str | None,
    model: str | None,
    strategy: str,
) -> tuple[str, list[dict]]:
    """Return a profile and source cues merged with valid cached translations."""
    profile = _translation_cache_profile(
        cues,
        provider=provider,
        base_url=base_url,
        model=model,
        strategy=strategy,
    )
    working = [dict(cue) for cue in cues]
    cached = _cache.get_translation(
        video_id, from_lang, segmentation, to_lang, profile,
    )
    if isinstance(cached, list) and len(cached) == len(working):
        for index, cached_cue in enumerate(cached):
            if cached_cue.get("text") == working[index].get("text"):
                working[index]["translation"] = cached_cue.get("translation", "")
    return profile, working


# ── yt-dlp helpers ─────────────────────────────────────────────────────

def _run_yt_dlp(args: list[str]) -> str:
    command = build_yt_dlp_command(args)
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
    # Whisper 兜底 — 无字幕时自动转音频
    whisper_enabled: bool = False
    whisper_api_key: str | None = None
    whisper_base_url: str | None = None
    whisper_model: str | None = None
    whisper_language: str | None = None  # 传给 Whisper 的 ISO-639 语言提示


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
    whisper_enabled: bool = False,
    whisper_api_key: str | None = None,
    whisper_base_url: str | None = None,
    whisper_model: str | None = None,
    whisper_language: str | None = None,
) -> tuple[dict, list[dict]]:
    """Shared sync portion: fetch metadata, pick track, download & segment.

    When whisper_enabled=True and no subtitle track is found, falls back to
    downloading audio and transcribing via Whisper.

    Returns (meta_dict, cues_list).
    """
    import tempfile
    from .audio import split_audio
    from .transcribe import WhisperClient, transcribe_timed_chunks

    # Metadata
    metadata = _fetch_metadata_cached(url)
    video_id = str(metadata.get("id") or "unknown")
    title = str(metadata.get("title") or video_id)

    # Select track
    selected = choose_subtitle(metadata, languages, allow_automatic)

    if selected is None and not whisper_enabled:
        raise HTTPException(status_code=404, detail="No matching subtitle track found")

    if selected is None and whisper_enabled:
        # ── Whisper fallback ──
        cache_profile = _whisper_cache_profile(
            whisper_language, whisper_base_url, whisper_model,
        )

        def cached_result() -> tuple[dict, list[dict]] | None:
            cached_cues = _cache.get_cues(
                video_id,
                cache_profile,
                _WHISPER_CACHE_VERSION,
                None,
                kind="whisper",
            )
            if not cached_cues:
                return None
            logger.info(
                "Whisper timed cue cache hit for %s (%d cues)",
                video_id, len(cached_cues),
            )
            return {
                "video_id": video_id, "title": title,
                "from_lang": whisper_language or "auto",
                "source": "whisper",
            }, cached_cues

        cached = cached_result()
        if cached:
            return cached

        # A refresh can start a second thread while the first transcription is
        # still running. Serialize the same video/profile and re-check inside
        # the lock so only one request downloads and transcribes the audio.
        lock_key = f"{video_id}:{cache_profile}"
        with _whisper_lock(lock_key):
            cached = cached_result()
            if cached:
                return cached

            logger.info("No subtitle track — falling back to Whisper transcription")
            try:
                with tempfile.TemporaryDirectory() as tmpdir:
                    audio_path = _download_audio(url, Path(tmpdir))
                    chunks_dir = Path(tmpdir) / "chunks"
                    chunks = split_audio(audio_path, chunks_dir, chunk_seconds=600)
                    client = WhisperClient(
                        api_key=whisper_api_key,
                        base_url=whisper_base_url,
                        model=whisper_model,
                    )
                    cues = transcribe_timed_chunks(
                        chunks,
                        client,
                        language=whisper_language,
                        chunk_seconds=600,
                    )

                if not cues:
                    raise HTTPException(
                        status_code=500, detail="Whisper returned no timed transcript",
                    )

                _cache.put_cues(
                    video_id,
                    cache_profile,
                    _WHISPER_CACHE_VERSION,
                    None,
                    cues,
                    kind="whisper",
                )
                logger.info(
                    "Whisper produced and cached %d timed cues spanning %.1fs",
                    len(cues), cues[-1]["end"] / 1000.0,
                )
                return {
                    "video_id": video_id, "title": title,
                    "from_lang": whisper_language or "auto",
                    "source": "whisper",
                }, cues
            except IngestError as exc:
                raise HTTPException(status_code=500, detail=f"Whisper fallback failed: {exc}")

    lang, source = selected
    logger.info("Selected subtitle: %s (%s)", lang, source)

    # Try cache for processed cues first (without translation)
    cached = _cache.get_cues(
        video_id,
        lang,
        segmentation,
        None,
        profile=_SEGMENTATION_CACHE_VERSION,
    )
    if cached:
        logger.info("Cache hit for %s/%s/%s", video_id, lang, segmentation)
        return {
            "video_id": video_id, "title": title,
            "from_lang": lang, "source": source,
        }, cached

    # Download json3
    json3_text = _cache.get_json3(video_id, lang)
    loaded_from_cache = json3_text is not None
    should_cache_json3 = not loaded_from_cache
    if json3_text is None:
        json3_text = _fetch_json3_subtitle(url, lang)
        if json3_text is None:
            raise HTTPException(status_code=500, detail="Failed to download subtitle")

    try:
        json3_data = json.loads(json3_text.lstrip("\ufeff"))
    except json.JSONDecodeError:
        if not loaded_from_cache:
            raise HTTPException(status_code=500, detail="Invalid subtitle JSON")

        # A partial write or an old yt-dlp response must not poison this video
        # until the cache TTL expires. Re-download once and replace it only
        # after validating the response.
        logger.warning("Invalid cached subtitle JSON for %s/%s; re-downloading", video_id, lang)
        json3_text = _fetch_json3_subtitle(url, lang)
        should_cache_json3 = True
        if json3_text is None:
            raise HTTPException(status_code=500, detail="Failed to download subtitle")
        try:
            json3_data = json.loads(json3_text.lstrip("\ufeff"))
        except json.JSONDecodeError:
            raise HTTPException(status_code=500, detail="Invalid subtitle JSON")

    # Cache only validated subtitle data.
    if should_cache_json3:
        _cache.put_json3(video_id, lang, json3_text)

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
    _cache.put_cues(
        video_id,
        lang,
        segmentation,
        None,
        cues,
        profile=_SEGMENTATION_CACHE_VERSION,
    )

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
        metadata = await run_in_threadpool(_fetch_metadata_cached, url)
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
        meta, cues = await run_in_threadpool(
            _process_subtitle_sync,
            url=req.url,
            languages=req.languages,
            allow_automatic=req.allow_automatic,
            segmentation=req.segmentation,
            whisper_enabled=req.whisper_enabled,
            whisper_api_key=req.whisper_api_key,
            whisper_base_url=req.whisper_base_url,
            whisper_model=req.whisper_model,
            whisper_language=req.whisper_language,
        )

        # Translate if requested
        to_lang = req.translate_to
        if to_lang and cues:
            strategy = "rest-whole-v1" if req.translate_whole else "rest-batch-v1"
            profile, cached_cues = _cached_translation(
                video_id=meta["video_id"],
                from_lang=meta["from_lang"],
                segmentation=req.segmentation,
                to_lang=to_lang,
                cues=cues,
                provider=req.translate_provider,
                base_url=req.translate_base_url,
                model=req.translate_model,
                strategy=strategy,
            )
            if all(
                str(cue.get("translation") or "").strip()
                not in ("", "[Translation failed]")
                for cue in cached_cues
            ):
                cues = cached_cues
            else:
                try:
                    cues = await translate_subtitles(
                        cues, from_lang=meta["from_lang"], to_lang=to_lang,
                        provider=req.translate_provider,
                        api_key=req.translate_api_key,
                        base_url=req.translate_base_url,
                        model=req.translate_model,
                        whole=req.translate_whole,
                    )
                    _cache.put_translation(
                        meta["video_id"],
                        meta["from_lang"],
                        req.segmentation,
                        to_lang,
                        profile,
                        cues,
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
        meta, cues = await run_in_threadpool(
            _process_subtitle_sync,
            url=req.url,
            languages=req.languages,
            allow_automatic=req.allow_automatic,
            segmentation=req.segmentation,
            whisper_enabled=req.whisper_enabled,
            whisper_api_key=req.whisper_api_key,
            whisper_base_url=req.whisper_base_url,
            whisper_model=req.whisper_model,
            whisper_language=req.whisper_language,
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
            yield f"data: {json.dumps({'type': 'meta', **meta, 'to_lang': None, 'segmentation': req.segmentation, 'total_cues': len(cues)}, ensure_ascii=False)}\n\n"
            for i, c in enumerate(cues):
                yield f"data: {json.dumps({'type': 'cue', 'index': i, **c}, ensure_ascii=False)}\n\n"
            yield "data: {\"type\":\"done\"}\n\n"
        return StreamingResponse(
            _no_translate(), media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    # Stream source cues immediately, then translate in bounded concurrent chunks.
    # Long videos no longer depend on a single silent HTTP request completing before
    # Cloudflare's proxy timeout. Completed chunks are cached so reconnects resume.
    async def _event_stream():
        total = len(cues)
        # Long videos always use context chunks, even when an older extension
        # sends translate_whole=false.
        use_context_chunks = req.translate_whole or total >= 100
        chunk_size = 10 if use_context_chunks else 12
        strategy = f"sse-{'context' if use_context_chunks else 'batch'}-{chunk_size}-v1"
        profile, working = _cached_translation(
            video_id=meta["video_id"],
            from_lang=meta["from_lang"],
            segmentation=req.segmentation,
            to_lang=to_lang,
            cues=cues,
            provider=req.translate_provider,
            base_url=req.translate_base_url,
            model=req.translate_model,
            strategy=strategy,
        )

        def is_complete(cue: dict) -> bool:
            translation = str(cue.get("translation") or "").strip()
            return bool(translation and translation != "[Translation failed]")

        completed = {idx for idx, cue in enumerate(working) if is_complete(cue)}
        yield f"data: {json.dumps({'type': 'meta', **meta, 'to_lang': to_lang, 'segmentation': req.segmentation, 'total_cues': total, 'completed_cues': len(completed)}, ensure_ascii=False)}\n\n"
        for idx, cue in enumerate(working):
            source_cue = {**cue, "translation": cue.get("translation", "")}
            yield f"data: {json.dumps({'type': 'source_cue', 'index': idx, **source_cue}, ensure_ascii=False)}\n\n"
        for idx in sorted(completed):
            yield f"data: {json.dumps({'type': 'cue', 'index': idx, **working[idx], 'cached': True}, ensure_ascii=False)}\n\n"

        pending_indices = [idx for idx in range(total) if idx not in completed]
        if not pending_indices:
            yield f"data: {json.dumps({'type': 'done', 'total_cues': total, 'failed_cues': 0})}\n\n"
            return

        chunks = [
            pending_indices[start:start + chunk_size]
            for start in range(0, len(pending_indices), chunk_size)
        ]
        semaphore = asyncio.Semaphore(3)
        job_key = f"{meta['video_id']}:{profile}"
        if job_key in _active_sse_jobs:
            yield f"data: {json.dumps({'type': 'error', 'code': 'translation_already_running', 'detail': '该视频已有翻译任务正在运行，请稍后重试', 'hide_after_ms': 30000}, ensure_ascii=False)}\n\n"
            return

        async def translate_chunk(indices: list[int]) -> tuple[list[int], list[dict] | None]:
            async with semaphore:
                batch = [working[idx] for idx in indices]
                for attempt in range(2):
                    try:
                        translated = await translate_subtitles(
                            batch,
                            from_lang=meta["from_lang"],
                            to_lang=to_lang,
                            provider=req.translate_provider,
                            api_key=req.translate_api_key,
                            base_url=req.translate_base_url,
                            model=req.translate_model,
                            concurrency=3,
                            timeout=60.0,
                            whole=use_context_chunks,
                            # DeepSeek occasionally ignores line markers even
                            # for a 10-cue chunk. Bound the fallback to this
                            # small chunk so every cue still gets translated.
                            whole_fallback_to_batch=True,
                        )
                        return indices, translated
                    except Exception as exc:
                        logger.warning(
                            "SSE chunk translation failed (attempt %d/2, cues %d-%d): %s",
                            attempt + 1, indices[0], indices[-1], exc,
                        )
                        if attempt == 0:
                            await asyncio.sleep(1)
                return indices, None

        tasks: set[asyncio.Task] = set()
        failed: set[int] = set()
        _active_sse_jobs.add(job_key)
        try:
            tasks = {asyncio.create_task(translate_chunk(indices)) for indices in chunks}
            while tasks:
                done, tasks = await asyncio.wait(
                    tasks, timeout=10.0, return_when=asyncio.FIRST_COMPLETED,
                )
                if not done:
                    yield ": keepalive\n\n"
                    continue

                for task in done:
                    indices, translated = await task
                    if translated is None:
                        failed.update(indices)
                        continue

                    for idx, translated_cue in zip(indices, translated):
                        translation = str(translated_cue.get("translation") or "").strip()
                        if not translation or translation == "[Translation failed]":
                            failed.add(idx)
                            continue
                        working[idx]["translation"] = translation
                        completed.add(idx)
                        yield f"data: {json.dumps({'type': 'cue', 'index': idx, **working[idx]}, ensure_ascii=False)}\n\n"

                    # A partial cache makes a reconnect resume only unfinished cues.
                    _cache.put_translation(
                        meta["video_id"],
                        meta["from_lang"],
                        req.segmentation,
                        to_lang,
                        profile,
                        working,
                    )
        finally:
            for task in tasks:
                task.cancel()
            if tasks:
                await asyncio.gather(*tasks, return_exceptions=True)
            _active_sse_jobs.discard(job_key)

        yield f"data: {json.dumps({'type': 'done', 'total_cues': total, 'failed_cues': len(failed)}, ensure_ascii=False)}\n\n"

    return StreamingResponse(
        _event_stream(), media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


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
        meta, cues = await run_in_threadpool(
            _process_subtitle_sync,
            url=req.url,
            languages=req.languages,
            allow_automatic=req.allow_automatic,
            segmentation=req.segmentation,
            whisper_enabled=req.whisper_enabled,
            whisper_api_key=req.whisper_api_key,
            whisper_base_url=req.whisper_base_url,
            whisper_model=req.whisper_model,
            whisper_language=req.whisper_language,
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
        profile, working = _cached_translation(
            video_id=meta["video_id"],
            from_lang=meta["from_lang"],
            segmentation=req.segmentation,
            to_lang=to_lang,
            cues=cues,
            provider=req.translate_provider,
            base_url=req.translate_base_url,
            model=req.translate_model,
            strategy="websocket-stream-v1",
        )
        for idx, cue in enumerate(working):
            text = cue["text"]
            cached_value = str(cue.get("translation") or "").strip()
            if cached_value and cached_value != "[Translation failed]":
                await ws.send_json({"type": "cue", "index": idx, **cue, "cached": True})
                continue
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
                _cache.put_translation(
                    meta["video_id"],
                    meta["from_lang"],
                    req.segmentation,
                    to_lang,
                    profile,
                    working,
                )
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


@app.delete("/api/cache")
async def clear_all_cache():
    """Clear every cache entry."""
    removed = _cache.clear_all()
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
