"""Simple disk-backed cache for subtitle metadata and processed results.

Avoids re-fetching the same YouTube video metadata / subtitle json3
on every request.  Keys are video-id scoped and have a configurable TTL.
"""

from __future__ import annotations

import json
import logging
import time
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)


class SubtitleCache:
    """File-system cache with per-key TTL.

    Layout:
        cache_dir/
          <video_id>.metadata.json
          <video_id>.<lang>.json3
          <video_id>.<lang>.<segmentation>.<to_lang>.cues.json
    """

    def __init__(self, cache_dir: Path, ttl_seconds: float = 86400) -> None:
        self.cache_dir = Path(cache_dir)
        self.ttl_seconds = ttl_seconds
        self.cache_dir.mkdir(parents=True, exist_ok=True)

    def _path(self, *parts: str) -> Path:
        safe = [p.replace("/", "_").replace("\\", "_") for p in parts]
        return self.cache_dir / "_".join(safe)

    def _is_fresh(self, path: Path) -> bool:
        if not path.exists():
            return False
        return (time.time() - path.stat().st_mtime) < self.ttl_seconds

    # ── metadata ─────────────────────────────────────────────────

    def get_metadata(self, video_id: str) -> dict[str, Any] | None:
        path = self._path(video_id, "metadata.json")
        if not self._is_fresh(path):
            return None
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return None

    def put_metadata(self, video_id: str, data: dict[str, Any]) -> None:
        path = self._path(video_id, "metadata.json")
        path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")

    # ── raw subtitle json3 ────────────────────────────────────────

    def get_json3(self, video_id: str, lang: str) -> str | None:
        path = self._path(video_id, lang, "json3.txt")
        if not self._is_fresh(path):
            return None
        try:
            return path.read_text(encoding="utf-8")
        except OSError:
            return None

    def put_json3(self, video_id: str, lang: str, data: str) -> None:
        path = self._path(video_id, lang, "json3.txt")
        path.write_text(data, encoding="utf-8")

    # ── processed cues ────────────────────────────────────────────

    def get_cues(
        self, video_id: str, lang: str, segmentation: str, to_lang: str | None
    ) -> list[dict] | None:
        tl = to_lang or "none"
        path = self._path(video_id, lang, segmentation, f"{tl}.cues.json")
        if not self._is_fresh(path):
            return None
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return None

    def put_cues(
        self, video_id: str, lang: str, segmentation: str,
        to_lang: str | None, cues: list[dict],
    ) -> None:
        tl = to_lang or "none"
        path = self._path(video_id, lang, segmentation, f"{tl}.cues.json")
        path.write_text(json.dumps(cues, ensure_ascii=False), encoding="utf-8")

    # ── maintenance ───────────────────────────────────────────────

    def purge_expired(self) -> int:
        """Remove cache entries older than ttl.  Returns count of removed files."""
        removed = 0
        cutoff = time.time() - self.ttl_seconds
        for path in self.cache_dir.iterdir():
            if path.is_file() and path.stat().st_mtime < cutoff:
                path.unlink()
                removed += 1
        return removed

    def clear_video(self, video_id: str) -> int:
        """Remove all cache entries for a video.  Returns count of removed files."""
        removed = 0
        prefix = video_id + "_"
        for path in self.cache_dir.iterdir():
            if path.is_file() and path.name.startswith(prefix):
                path.unlink()
                removed += 1
        return removed
