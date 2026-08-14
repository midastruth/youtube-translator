from __future__ import annotations

import html
import json
import os
import re
import subprocess
import sys
from pathlib import Path
from typing import Any, Iterable

from .errors import IngestError


def build_yt_dlp_command(args: list[str]) -> list[str]:
    """Build a yt-dlp command with optional YouTube extraction helpers."""
    command = [sys.executable, "-m", "yt_dlp"]

    youtube_client = os.getenv("YTDLP_YOUTUBE_CLIENT", "").strip()
    if youtube_client:
        command.extend([
            "--extractor-args",
            f"youtube:player_client={youtube_client}",
        ])

    pot_provider_url = os.getenv("YTDLP_POT_PROVIDER_URL", "").strip().rstrip("/")
    if pot_provider_url:
        command.extend([
            "--extractor-args",
            f"youtubepot-bgutilhttp:base_url={pot_provider_url}",
        ])

    return [*command, *args]


def _run_yt_dlp(args: list[str]) -> str:
    command = build_yt_dlp_command(args)
    try:
        result = subprocess.run(
            command,
            check=True,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
    except subprocess.CalledProcessError as exc:
        detail = (exc.stderr or exc.stdout or str(exc)).strip()
        raise IngestError(f"yt-dlp failed: {detail}") from exc
    return result.stdout.strip()


def fetch_metadata(url: str) -> dict[str, Any]:
    raw = _run_yt_dlp(["--dump-single-json", "--skip-download", "--no-warnings", url])
    try:
        return json.loads(raw)
    except json.JSONDecodeError as exc:
        raise IngestError("yt-dlp returned invalid metadata JSON") from exc


def choose_subtitle(
    metadata: dict[str, Any],
    languages: Iterable[str],
    allow_automatic: bool = True,
) -> tuple[str, str] | None:
    """Return (language, source), preferring manual subtitles over automatic ones."""
    requested = [language.strip() for language in languages if language.strip()]
    sources = [("manual", metadata.get("subtitles") or {})]
    if allow_automatic:
        sources.append(("automatic", metadata.get("automatic_captions") or {}))

    for source_name, available in sources:
        keys = list(available)
        for requested_language in requested:
            exact = next((key for key in keys if key.lower() == requested_language.lower()), None)
            if exact:
                return exact, source_name
            prefix = requested_language.lower().split("-")[0]
            related = next(
                (key for key in keys if key.lower().split("-")[0] == prefix),
                None,
            )
            if related:
                return related, source_name
    return None


def download_subtitle(url: str, language: str, source_dir: Path) -> Path:
    source_dir.mkdir(parents=True, exist_ok=True)
    template = str(source_dir / "subtitle.%(ext)s")
    _run_yt_dlp(
        [
            "--skip-download",
            "--write-sub",
            "--write-auto-sub",
            "--sub-langs",
            language,
            "--sub-format",
            "vtt",
            "--output",
            template,
            "--no-warnings",
            url,
        ]
    )
    candidates = sorted(source_dir.glob("subtitle*.vtt"))
    if not candidates:
        raise IngestError(f"yt-dlp did not produce a VTT subtitle for {language}")
    return candidates[0]


_TIMING_RE = re.compile(
    r"^\s*(?:\d{2}:)?\d{2}:\d{2}[.,]\d{3}\s+-->\s+(?:\d{2}:)?\d{2}:\d{2}[.,]\d{3}"
)
_TAG_RE = re.compile(r"<[^>]+>")


def vtt_to_text(path: Path) -> str:
    """Convert WebVTT into readable text and collapse rolling-caption duplicates."""
    lines: list[str] = []
    previous = ""
    raw_lines = path.read_text(encoding="utf-8-sig").splitlines()
    for index, raw_line in enumerate(raw_lines):
        line = raw_line.strip()
        next_line = raw_lines[index + 1].strip() if index + 1 < len(raw_lines) else ""
        if (
            not line
            or line == "WEBVTT"
            or line.startswith(("Kind:", "Language:", "NOTE", "STYLE", "REGION"))
            or _TIMING_RE.match(line)
            or (line.isdigit() and _TIMING_RE.match(next_line))
        ):
            continue
        line = html.unescape(_TAG_RE.sub("", line)).strip()
        if not line or line == previous:
            continue
        # Auto captions often repeat the previous cue and append a few words.
        if previous and line.startswith(previous):
            lines[-1] = line
        else:
            lines.append(line)
        previous = line
    return "\n".join(lines).strip() + "\n"


def download_audio(url: str, source_dir: Path) -> Path:
    source_dir.mkdir(parents=True, exist_ok=True)
    template = str(source_dir / "audio.%(ext)s")
    output = _run_yt_dlp(
        [
            "--format",
            "bestaudio/best",
            "--extract-audio",
            "--audio-format",
            "mp3",
            "--audio-quality",
            "5",
            "--output",
            template,
            "--print",
            "after_move:filepath",
            "--no-warnings",
            url,
        ]
    )
    reported_paths = [Path(line) for line in output.splitlines() if line.strip()]
    for path in reversed(reported_paths):
        if path.exists():
            return path
    candidates = sorted(source_dir.glob("audio.*"))
    if not candidates:
        raise IngestError("yt-dlp did not produce an audio file")
    return candidates[0]
