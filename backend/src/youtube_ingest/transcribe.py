from __future__ import annotations

import os
import time
from pathlib import Path

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

    def transcribe(self, audio_path: Path, language: str | None = None) -> str:
        try:
            import httpx
        except ImportError as exc:
            raise IngestError("httpx is required for audio transcription; install the project dependencies") from exc

        endpoint = f"{self.base_url}/audio/transcriptions"
        data = {"model": self.model, "response_format": "json", "temperature": "0"}
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
                text = response.json().get("text", "").strip()
                if not text:
                    raise IngestError(f"transcription API returned no text for {audio_path.name}")
                return text
            except (httpx.HTTPError, ValueError, IngestError) as exc:
                last_error = exc
                if attempt + 1 < self.retries:
                    time.sleep(2**attempt)
        raise IngestError(f"transcription failed for {audio_path.name}: {last_error}")


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
