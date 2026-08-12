"""Disk-backed cache for subtitle metadata and processed results.

Cheap, changeable upstream data has a finite TTL. Expensive derived data such
as segmentation, transcription, and translation is retained until a cache
version changes or the configured disk budget evicts it.
"""

from __future__ import annotations

import json
import logging
import os
import tempfile
import threading
import time
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)


class SubtitleCache:
    """File-system cache with per-kind TTL and a disk-size LRU limit.

    A TTL of ``None`` or ``0`` means that kind does not expire by age.
    ``ttl_seconds`` is retained for backwards compatibility and, when set,
    overrides every per-kind TTL.

    Layout:
        cache_dir/
          <video_id>_metadata.json
          <video_id>_<lang>_json3.txt
          <video_id>_<lang>_<segmentation>_<to_lang>.cues.json
          <video_id>_<lang>_<segmentation>_<to_lang>_<profile>.cues.json
    """

    DEFAULT_MAX_BYTES = 5 * 1024 * 1024 * 1024

    def __init__(
        self,
        cache_dir: Path,
        ttl_seconds: float | None = None,
        *,
        metadata_ttl_seconds: float | None = 86400,
        json3_ttl_seconds: float | None = 30 * 86400,
        cues_ttl_seconds: float | None = None,
        translation_ttl_seconds: float | None = None,
        whisper_ttl_seconds: float | None = None,
        max_bytes: int | None = DEFAULT_MAX_BYTES,
        maintenance_interval_seconds: float = 86400,
    ) -> None:
        self.cache_dir = Path(cache_dir)
        if ttl_seconds is not None:
            metadata_ttl_seconds = ttl_seconds
            json3_ttl_seconds = ttl_seconds
            cues_ttl_seconds = ttl_seconds
            translation_ttl_seconds = ttl_seconds
            whisper_ttl_seconds = ttl_seconds
        # Kept as a public attribute for callers that used the old API.
        self.ttl_seconds = ttl_seconds
        self.ttls = {
            "metadata": self._normalize_ttl(metadata_ttl_seconds),
            "json3": self._normalize_ttl(json3_ttl_seconds),
            "cues": self._normalize_ttl(cues_ttl_seconds),
            "translation": self._normalize_ttl(translation_ttl_seconds),
            "whisper": self._normalize_ttl(whisper_ttl_seconds),
        }
        self.max_bytes = int(max_bytes) if max_bytes and max_bytes > 0 else None
        self.maintenance_interval_seconds = max(0.0, maintenance_interval_seconds)
        self._lock = threading.RLock()
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self._last_maintenance = time.monotonic()
        self.maintain()

    @staticmethod
    def _normalize_ttl(value: float | None) -> float | None:
        return float(value) if value is not None and value > 0 else None

    def _path(self, *parts: str) -> Path:
        safe = [str(p).replace("/", "_").replace("\\", "_") for p in parts]
        return self.cache_dir / "_".join(safe)

    def _is_fresh(self, path: Path, kind: str = "cues") -> bool:
        try:
            modified_at = path.stat().st_mtime
        except OSError:
            return False
        ttl = self.ttls[kind]
        return ttl is None or (time.time() - modified_at) < ttl

    @staticmethod
    def _touch_access(path: Path) -> None:
        """Update atime for LRU without changing mtime used for TTL."""
        try:
            stat = path.stat()
            os.utime(path, (time.time(), stat.st_mtime))
        except OSError:
            pass

    def _read_text(self, path: Path, kind: str) -> str | None:
        if not self._is_fresh(path, kind):
            return None
        try:
            value = path.read_text(encoding="utf-8")
            self._touch_access(path)
            self._maybe_maintain()
            return value
        except OSError:
            return None

    def _write_text(self, path: Path, value: str) -> None:
        """Atomically replace a cache entry, then enforce the disk budget."""
        temp_name: str | None = None
        with self._lock:
            try:
                with tempfile.NamedTemporaryFile(
                    mode="w",
                    encoding="utf-8",
                    dir=self.cache_dir,
                    prefix=".cache-tmp-",
                    delete=False,
                ) as temp_file:
                    temp_file.write(value)
                    temp_file.flush()
                    os.fsync(temp_file.fileno())
                    temp_name = temp_file.name
                os.replace(temp_name, path)
                temp_name = None
            finally:
                if temp_name:
                    try:
                        Path(temp_name).unlink()
                    except OSError:
                        pass
            self._maybe_maintain(force_size_check=True)

    # ── metadata ─────────────────────────────────────────────────

    def get_metadata(self, video_id: str) -> dict[str, Any] | None:
        text = self._read_text(self._path(video_id, "metadata.json"), "metadata")
        if text is None:
            return None
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            return None

    def put_metadata(self, video_id: str, data: dict[str, Any]) -> None:
        self._write_text(
            self._path(video_id, "metadata.json"),
            json.dumps(data, ensure_ascii=False),
        )

    # ── raw subtitle json3 ────────────────────────────────────────

    def get_json3(self, video_id: str, lang: str) -> str | None:
        return self._read_text(self._path(video_id, lang, "json3.txt"), "json3")

    def put_json3(self, video_id: str, lang: str, data: str) -> None:
        self._write_text(self._path(video_id, lang, "json3.txt"), data)

    # ── processed cues ────────────────────────────────────────────

    def _cues_path(
        self,
        video_id: str,
        lang: str,
        segmentation: str,
        to_lang: str | None,
        profile: str | None = None,
    ) -> Path:
        parts = [video_id, lang, segmentation]
        if profile:
            parts.extend((to_lang or "none", f"{profile}.cues.json"))
        else:
            parts.append(f"{to_lang or 'none'}.cues.json")
        return self._path(*parts)

    def get_cues(
        self,
        video_id: str,
        lang: str,
        segmentation: str,
        to_lang: str | None,
        *,
        kind: str = "cues",
        profile: str | None = None,
    ) -> list[dict] | None:
        text = self._read_text(
            self._cues_path(video_id, lang, segmentation, to_lang, profile),
            kind,
        )
        if text is None:
            return None
        try:
            value = json.loads(text)
            return value if isinstance(value, list) else None
        except json.JSONDecodeError:
            return None

    def put_cues(
        self,
        video_id: str,
        lang: str,
        segmentation: str,
        to_lang: str | None,
        cues: list[dict],
        *,
        kind: str = "cues",
        profile: str | None = None,
    ) -> None:
        # kind selects retention policy; profile selects the file name.
        if kind not in self.ttls:
            raise ValueError(f"Unknown cache kind: {kind}")
        self._write_text(
            self._cues_path(video_id, lang, segmentation, to_lang, profile),
            json.dumps(cues, ensure_ascii=False),
        )

    def get_translation(
        self,
        video_id: str,
        lang: str,
        segmentation: str,
        to_lang: str,
        profile: str,
    ) -> list[dict] | None:
        return self.get_cues(
            video_id,
            lang,
            segmentation,
            to_lang,
            kind="translation",
            profile=profile,
        )

    def put_translation(
        self,
        video_id: str,
        lang: str,
        segmentation: str,
        to_lang: str,
        profile: str,
        cues: list[dict],
    ) -> None:
        self.put_cues(
            video_id,
            lang,
            segmentation,
            to_lang,
            cues,
            kind="translation",
            profile=profile,
        )

    # ── maintenance ───────────────────────────────────────────────

    def _kind_for_path(self, path: Path) -> str | None:
        name = path.name
        if name.endswith("_metadata.json"):
            return "metadata"
        if name.endswith("_json3.txt"):
            return "json3"
        if not name.endswith(".cues.json"):
            return None
        if "_whisper-" in name:
            return "whisper"
        if "_translation-" in name:
            return "translation"
        if "_none_" in name or name.endswith("_none.cues.json"):
            return "cues"
        return "translation"

    def purge_expired(self) -> int:
        """Remove entries past their kind-specific TTL."""
        removed = 0
        now = time.time()
        with self._lock:
            for path in self.cache_dir.iterdir():
                if not path.is_file() or path.name.startswith(".cache-tmp-"):
                    continue
                kind = self._kind_for_path(path)
                ttl = self.ttls.get(kind) if kind else None
                try:
                    if ttl is not None and now - path.stat().st_mtime >= ttl:
                        path.unlink()
                        removed += 1
                except OSError:
                    continue
        return removed

    def enforce_size_limit(self) -> int:
        """Evict least-recently-read entries until under ``max_bytes``."""
        if self.max_bytes is None:
            return 0
        with self._lock:
            entries: list[tuple[int, int, Path]] = []
            total = 0
            for path in self.cache_dir.iterdir():
                if not path.is_file() or path.name.startswith(".cache-tmp-"):
                    continue
                try:
                    stat = path.stat()
                except OSError:
                    continue
                total += stat.st_size
                entries.append((stat.st_atime_ns, stat.st_size, path))
            if total <= self.max_bytes:
                return 0

            removed = 0
            for _, size, path in sorted(entries):
                try:
                    path.unlink()
                except OSError:
                    continue
                total -= size
                removed += 1
                if total <= self.max_bytes:
                    break
            return removed

    def maintain(self) -> int:
        """Purge expired entries and enforce the configured disk budget."""
        with self._lock:
            removed = self.purge_expired() + self.enforce_size_limit()
            self._last_maintenance = time.monotonic()
            return removed

    def _maybe_maintain(self, *, force_size_check: bool = False) -> None:
        due = (
            self.maintenance_interval_seconds == 0
            or time.monotonic() - self._last_maintenance
            >= self.maintenance_interval_seconds
        )
        if due:
            self.maintain()
        elif force_size_check:
            self.enforce_size_limit()

    def clear_video(self, video_id: str) -> int:
        """Remove all cache entries for a video. Returns count removed."""
        removed = 0
        prefix = video_id.replace("/", "_").replace("\\", "_") + "_"
        with self._lock:
            for path in self.cache_dir.iterdir():
                if path.is_file() and path.name.startswith(prefix):
                    try:
                        path.unlink()
                        removed += 1
                    except OSError:
                        continue
        return removed

    def clear_all(self) -> int:
        """Remove every regular cache entry. Returns count removed."""
        removed = 0
        with self._lock:
            for path in self.cache_dir.iterdir():
                if not path.is_file():
                    continue
                try:
                    path.unlink()
                    removed += 1
                except OSError:
                    continue
        return removed
