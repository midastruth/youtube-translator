from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

from .errors import IngestError


def ensure_ffmpeg() -> None:
    if shutil.which("ffmpeg") is None:
        raise IngestError("ffmpeg is required but was not found on PATH")


def split_audio(audio_path: Path, chunks_dir: Path, chunk_seconds: int = 600) -> list[Path]:
    if chunk_seconds <= 0:
        raise IngestError("chunk_seconds must be greater than zero")
    ensure_ffmpeg()
    chunks_dir.mkdir(parents=True, exist_ok=True)
    pattern = str(chunks_dir / "chunk_%03d.mp3")
    command = [
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        str(audio_path),
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-b:a",
        "64k",
        "-f",
        "segment",
        "-segment_time",
        str(chunk_seconds),
        "-segment_start_number",
        "1",
        "-reset_timestamps",
        "1",
        pattern,
    ]
    try:
        subprocess.run(command, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    except subprocess.CalledProcessError as exc:
        raise IngestError(f"ffmpeg failed: {exc.stderr.strip()}") from exc
    chunks = sorted(chunks_dir.glob("chunk_*.mp3"))
    if not chunks:
        raise IngestError("ffmpeg did not produce any audio chunks")
    return chunks
