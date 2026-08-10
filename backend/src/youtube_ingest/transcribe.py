from __future__ import annotations

import os
import re
import time
from pathlib import Path
from typing import Any

from .errors import IngestError


class WhisperClient:
    def __init__(
        self,
        api_key: str | None = None,
        base_url: str | None = None,
        model: str | None = None,
        timeout_seconds: float = 180.0,
        retries: int = 3,
    ) -> None:
        self.api_key = api_key or os.getenv("WHISPER_API_KEY") or os.getenv("GROQ_API_KEY")
        self.base_url = (base_url or os.getenv("WHISPER_BASE_URL") or "https://api.groq.com/openai/v1").rstrip("/")
        self.model = model or os.getenv("WHISPER_MODEL") or "whisper-large-v3"
        self.timeout_seconds = timeout_seconds
        self.retries = retries
        if not self.api_key:
            raise IngestError("Set WHISPER_API_KEY (or GROQ_API_KEY) before audio transcription")

    def _request(
        self,
        audio_path: Path,
        language: str | None,
        response_format: str,
        timestamps: bool = False,
    ) -> dict[str, Any]:
        try:
            import httpx
        except ImportError as exc:
            raise IngestError("httpx is required for audio transcription; install the project dependencies") from exc

        endpoint = f"{self.base_url}/audio/transcriptions"
        data = {
            "model": self.model,
            "response_format": response_format,
            "temperature": "0",
        }
        if timestamps:
            # OpenAI-compatible multipart APIs use the bracketed field name.
            data["timestamp_granularities[]"] = "segment"
        if language:
            data["language"] = language

        last_error: Exception | None = None
        for attempt in range(self.retries):
            try:
                with audio_path.open("rb") as audio_file:
                    response = httpx.post(
                        endpoint,
                        headers={"Authorization": f"Bearer {self.api_key}"},
                        data=data,
                        files={"file": (audio_path.name, audio_file, "audio/mpeg")},
                        timeout=self.timeout_seconds,
                    )
                response.raise_for_status()
                payload = response.json()
                if not isinstance(payload, dict):
                    raise IngestError(
                        f"transcription API returned invalid JSON for {audio_path.name}"
                    )
                return payload
            except (httpx.HTTPError, ValueError, IngestError) as exc:
                last_error = exc
                if attempt + 1 < self.retries:
                    time.sleep(2**attempt)
        raise IngestError(f"transcription failed for {audio_path.name}: {last_error}")

    def transcribe(self, audio_path: Path, language: str | None = None) -> str:
        payload = self._request(audio_path, language, response_format="json")
        text = str(payload.get("text") or "").strip()
        if not text:
            raise IngestError(f"transcription API returned no text for {audio_path.name}")
        return text

    def transcribe_timed(
        self,
        audio_path: Path,
        language: str | None = None,
    ) -> dict[str, Any]:
        """Return transcript text plus second-based segment timestamps.

        Groq and OpenAI-compatible Whisper endpoints expose segment timestamps
        through ``verbose_json``. Providers without that format fall back to a
        normal text transcription; ``transcribe_timed_chunks`` then creates a
        bounded sentence timeline instead of collapsing a whole chunk to 5s.
        """
        try:
            payload = self._request(
                audio_path,
                language,
                response_format="verbose_json",
                timestamps=True,
            )
        except IngestError:
            return {
                "text": self.transcribe(audio_path, language=language),
                "segments": [],
                "language": language,
            }

        segments: list[dict[str, Any]] = []
        raw_segments = payload.get("segments")
        if isinstance(raw_segments, list):
            for raw in raw_segments:
                if not isinstance(raw, dict):
                    continue
                text = str(raw.get("text") or "").strip()
                try:
                    start = float(raw.get("start"))
                    end = float(raw.get("end"))
                except (TypeError, ValueError):
                    continue
                if not text or start < 0 or end <= start:
                    continue
                segments.append({"start": start, "end": end, "text": text})

        text = str(payload.get("text") or "").strip()
        if not text and segments:
            text = " ".join(segment["text"] for segment in segments)
        if not text:
            raise IngestError(f"transcription API returned no text for {audio_path.name}")

        return {
            "text": text,
            "segments": segments,
            "duration": payload.get("duration"),
            "language": payload.get("language") or language,
        }


def transcribe_chunks(
    chunks: list[Path],
    transcripts_dir: Path,
    client: WhisperClient,
    language: str | None = None,
) -> list[Path]:
    transcripts_dir.mkdir(parents=True, exist_ok=True)
    paths: list[Path] = []
    for chunk in chunks:
        transcript_path = transcripts_dir / f"{chunk.stem}.txt"
        text = client.transcribe(chunk, language=language)
        transcript_path.write_text(text.strip() + "\n", encoding="utf-8")
        paths.append(transcript_path)
    return paths


def merge_transcripts(paths: list[Path], destination: Path) -> None:
    parts = [path.read_text(encoding="utf-8").strip() for path in paths]
    destination.write_text("\n\n".join(part for part in parts if part) + "\n", encoding="utf-8")


_SENTENCE_BOUNDARY = re.compile(r"(?<=[.!?。！？])(?:\s+|$)|\n+")


def _fallback_segments(text: str, duration_seconds: float) -> list[dict[str, Any]]:
    """Distribute plain transcript sentences across a chunk duration."""
    parts = [part.strip() for part in _SENTENCE_BOUNDARY.split(text) if part.strip()]
    if not parts:
        return []

    duration = max(float(duration_seconds), len(parts) * 0.5)
    weights = [max(len(part), 1) for part in parts]
    total_weight = sum(weights)
    elapsed = 0.0
    segments: list[dict[str, Any]] = []
    for index, (part, weight) in enumerate(zip(parts, weights)):
        start = elapsed
        elapsed = duration if index == len(parts) - 1 else elapsed + duration * weight / total_weight
        segments.append({"start": start, "end": elapsed, "text": part})
    return segments


def transcribe_timed_chunks(
    chunks: list[Path],
    client: WhisperClient,
    language: str | None = None,
    chunk_seconds: int = 600,
) -> list[dict[str, Any]]:
    """Transcribe reset-timestamp chunks into one millisecond cue timeline."""
    if chunk_seconds <= 0:
        raise IngestError("chunk_seconds must be greater than zero")

    cues: list[dict[str, Any]] = []
    for chunk_index, chunk in enumerate(chunks):
        transcript = client.transcribe_timed(chunk, language=language)
        raw_segments = transcript.get("segments")
        segments = raw_segments if isinstance(raw_segments, list) else []
        if not segments:
            try:
                duration = float(transcript.get("duration") or chunk_seconds)
            except (TypeError, ValueError):
                duration = float(chunk_seconds)
            segments = _fallback_segments(str(transcript.get("text") or ""), duration)

        offset_seconds = chunk_index * chunk_seconds
        for segment in segments:
            text = str(segment.get("text") or "").strip()
            try:
                start = float(segment.get("start"))
                end = float(segment.get("end"))
            except (TypeError, ValueError):
                continue
            if not text or start < 0 or end <= start:
                continue
            cues.append({
                "start": (offset_seconds + start) * 1000.0,
                "end": (offset_seconds + end) * 1000.0,
                "text": text,
                "translation": "",
            })

    return cues
