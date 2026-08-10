from __future__ import annotations

import json
import re
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .audio import split_audio
from .transcribe import WhisperClient, merge_transcripts, transcribe_chunks
from .youtube import choose_subtitle, download_audio, download_subtitle, fetch_metadata, vtt_to_text


@dataclass(frozen=True)
class IngestResult:
    video_id: str
    title: str
    mode: str
    subtitle_language: str | None
    metadata_path: str
    transcript_path: str


def _safe_name(value: str) -> str:
    value = re.sub(r"[^\w.-]+", "-", value, flags=re.UNICODE).strip("-.")
    return value[:80] or "video"


def _public_metadata(metadata: dict[str, Any]) -> dict[str, Any]:
    fields = (
        "id",
        "title",
        "description",
        "channel",
        "channel_id",
        "uploader",
        "upload_date",
        "duration",
        "webpage_url",
        "thumbnail",
        "view_count",
        "like_count",
        "categories",
        "tags",
    )
    return {field: metadata.get(field) for field in fields}


def ingest(
    url: str,
    output_dir: Path,
    languages: list[str],
    allow_automatic_subtitles: bool = True,
    chunk_seconds: int = 600,
    transcription_language: str | None = None,
    whisper_base_url: str | None = None,
    whisper_model: str | None = None,
) -> IngestResult:
    metadata = fetch_metadata(url)
    video_id = str(metadata.get("id") or "unknown")
    title = str(metadata.get("title") or video_id)
    job_dir = output_dir / f"{_safe_name(title)}-{_safe_name(video_id)}"
    source_dir = job_dir / "source"
    job_dir.mkdir(parents=True, exist_ok=True)
    metadata_path = job_dir / "metadata.json"
    metadata_path.write_text(
        json.dumps(_public_metadata(metadata), ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    transcript_path = job_dir / "raw_transcript.txt"
    selected = choose_subtitle(metadata, languages, allow_automatic_subtitles)

    if selected:
        subtitle_language, subtitle_source = selected
        subtitle_path = download_subtitle(url, subtitle_language, source_dir)
        transcript_path.write_text(vtt_to_text(subtitle_path), encoding="utf-8")
        mode = f"subtitle:{subtitle_source}"
    else:
        subtitle_language = None
        audio_path = download_audio(url, source_dir)
        chunks = split_audio(audio_path, job_dir / "chunks", chunk_seconds)
        client = WhisperClient(base_url=whisper_base_url, model=whisper_model)
        transcript_parts = transcribe_chunks(
            chunks,
            job_dir / "transcripts",
            client,
            language=transcription_language,
        )
        merge_transcripts(transcript_parts, transcript_path)
        mode = "audio:whisper"

    result = IngestResult(
        video_id=video_id,
        title=title,
        mode=mode,
        subtitle_language=subtitle_language,
        metadata_path=str(metadata_path.resolve()),
        transcript_path=str(transcript_path.resolve()),
    )
    manifest = {
        **asdict(result),
        "source_url": url,
        "completed_at": datetime.now(timezone.utc).isoformat(),
    }
    (job_dir / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return result
