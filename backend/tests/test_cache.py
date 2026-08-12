"""Tests for SubtitleCache — disk-backed cache layer."""

import json
import os
import tempfile
import time
import unittest
from pathlib import Path

from youtube_ingest.cache import SubtitleCache


class CacheBasicTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.cache_dir = Path(self.tmp.name)
        self.cache = SubtitleCache(self.cache_dir, ttl_seconds=3600)

    def tearDown(self):
        self.tmp.cleanup()

    def test_cache_dir_created(self):
        self.assertTrue(self.cache_dir.exists())

    def test_put_and_get_metadata(self):
        data = {"id": "abc", "title": "Test Video"}
        self.cache.put_metadata("abc", data)
        result = self.cache.get_metadata("abc")
        self.assertEqual(result, data)

    def test_get_missing_metadata(self):
        self.assertIsNone(self.cache.get_metadata("nonexistent"))

    def test_put_and_get_json3(self):
        data = '{"events": []}'
        self.cache.put_json3("abc", "en", data)
        result = self.cache.get_json3("abc", "en")
        self.assertEqual(result, data)

    def test_get_missing_json3(self):
        self.assertIsNone(self.cache.get_json3("abc", "unknown"))

    def test_put_and_get_cues(self):
        cues = [{"start": 0, "end": 500, "text": "Hello", "translation": ""}]
        self.cache.put_cues("abc", "en", "rule", None, cues)
        result = self.cache.get_cues("abc", "en", "rule", None)
        self.assertEqual(result, cues)

    def test_get_cues_with_to_lang(self):
        cues = [{"start": 0, "end": 500, "text": "Hello", "translation": "你好"}]
        self.cache.put_cues("abc", "en", "statistical", "zh-CN", cues)
        result = self.cache.get_cues("abc", "en", "statistical", "zh-CN")
        self.assertEqual(result, cues)

    def test_cues_different_to_lang_not_confused(self):
        cues_en = [{"text": "Hello"}]
        cues_none = [{"text": "Hello", "translation": ""}]
        self.cache.put_cues("abc", "en", "rule", "zh-CN", cues_en)
        self.cache.put_cues("abc", "en", "rule", None, cues_none)
        self.assertEqual(self.cache.get_cues("abc", "en", "rule", "zh-CN"), cues_en)
        self.assertEqual(self.cache.get_cues("abc", "en", "rule", None), cues_none)

    def test_clear_video(self):
        self.cache.put_metadata("abc", {"id": "abc"})
        self.cache.put_json3("abc", "en", "{}")
        self.cache.put_cues("abc", "en", "rule", None, [])
        self.cache.put_metadata("xyz", {"id": "xyz"})
        self.cache.put_json3("xyz", "en", "{}")

        removed = self.cache.clear_video("abc")
        self.assertEqual(removed, 3)
        self.assertIsNone(self.cache.get_metadata("abc"))
        self.assertIsNone(self.cache.get_json3("abc", "en"))
        # xyz should be untouched
        self.assertIsNotNone(self.cache.get_metadata("xyz"))
        self.assertIsNotNone(self.cache.get_json3("xyz", "en"))

    def test_purge_expired(self):
        # Create a cache with very short TTL
        short_cache = SubtitleCache(self.cache_dir, ttl_seconds=0.01)
        short_cache.put_metadata("abc", {"id": "abc"})
        short_cache.put_json3("abc", "en", "{}")

        # Wait for TTL to expire
        time.sleep(0.02)

        removed = short_cache.purge_expired()
        self.assertEqual(removed, 2)
        self.assertIsNone(self.cache.get_metadata("abc"))
        self.assertIsNone(self.cache.get_json3("abc", "en"))

    def test_ttl_expiry(self):
        short_cache = SubtitleCache(self.cache_dir, ttl_seconds=0.01)
        short_cache.put_metadata("abc", {"id": "abc"})
        self.assertIsNotNone(short_cache.get_metadata("abc"))

        time.sleep(0.02)
        # After TTL, get should return None
        self.assertIsNone(short_cache.get_metadata("abc"))

    def test_corrupted_json_returns_none(self):
        path = self.cache._path("abc", "metadata.json")
        path.write_text("not valid json{{{", encoding="utf-8")
        self.assertIsNone(self.cache.get_metadata("abc"))

    def test_special_characters_in_keys(self):
        cues = [{"text": "test"}]
        self.cache.put_cues("video/with\\special", "zh-Hans", "rule", "en-US", cues)
        result = self.cache.get_cues("video/with\\special", "zh-Hans", "rule", "en-US")
        self.assertEqual(result, cues)
        # Verify no filesystem errors by checking the path exists
        self.assertTrue(any(
            p.name.startswith("video_with_special_") for p in self.cache_dir.iterdir()
        ))

    def test_clear_nonexistent_video(self):
        removed = self.cache.clear_video("nonexistent")
        self.assertEqual(removed, 0)

    def test_purge_empty_cache(self):
        removed = self.cache.purge_expired()
        self.assertEqual(removed, 0)

    def test_kind_specific_ttls_keep_expensive_results(self):
        cache = SubtitleCache(
            self.cache_dir,
            metadata_ttl_seconds=0.01,
            json3_ttl_seconds=0.01,
            cues_ttl_seconds=0,
            translation_ttl_seconds=0,
            whisper_ttl_seconds=0,
            max_bytes=0,
        )
        cache.put_metadata("abc", {"id": "abc"})
        cache.put_json3("abc", "en", "{}")
        cache.put_cues("abc", "en", "rule", None, [{"text": "source"}])
        cache.put_translation(
            "abc", "en", "rule", "zh-CN", "profile-a",
            [{"text": "source", "translation": "译文"}],
        )
        cache.put_cues(
            "abc", "whisper-auto-profile", "whisper-v1", None,
            [{"text": "transcript"}], kind="whisper",
        )

        time.sleep(0.02)
        removed = cache.purge_expired()

        self.assertEqual(removed, 2)
        self.assertIsNone(cache.get_metadata("abc"))
        self.assertIsNone(cache.get_json3("abc", "en"))
        self.assertIsNotNone(cache.get_cues("abc", "en", "rule", None))
        self.assertIsNotNone(cache.get_translation(
            "abc", "en", "rule", "zh-CN", "profile-a",
        ))
        self.assertIsNotNone(cache.get_cues(
            "abc", "whisper-auto-profile", "whisper-v1", None,
            kind="whisper",
        ))

    def test_translation_profiles_are_isolated(self):
        first = [{"text": "Hello", "translation": "你好"}]
        second = [{"text": "Hello", "translation": "您好"}]
        self.cache.put_translation(
            "abc", "en", "rule", "zh-CN", "model-a", first,
        )
        self.cache.put_translation(
            "abc", "en", "rule", "zh-CN", "model-b", second,
        )

        self.assertEqual(self.cache.get_translation(
            "abc", "en", "rule", "zh-CN", "model-a",
        ), first)
        self.assertEqual(self.cache.get_translation(
            "abc", "en", "rule", "zh-CN", "model-b",
        ), second)

    def test_size_limit_evicts_least_recently_used(self):
        cache = SubtitleCache(self.cache_dir, max_bytes=0)
        cache.put_json3("old", "en", "old-value")
        cache.put_json3("new", "en", "new-value")
        old_path = cache._path("old", "en", "json3.txt")
        new_path = cache._path("new", "en", "json3.txt")
        now = time.time()
        os.utime(old_path, (now - 100, now))
        os.utime(new_path, (now, now))
        cache.max_bytes = new_path.stat().st_size

        removed = cache.enforce_size_limit()

        self.assertEqual(removed, 1)
        self.assertFalse(old_path.exists())
        self.assertTrue(new_path.exists())

    def test_writes_are_atomic_and_leave_no_temp_files(self):
        self.cache.put_json3("abc", "en", '{"events": []}')
        self.assertFalse(any(
            path.name.startswith(".cache-tmp-")
            for path in self.cache_dir.iterdir()
        ))

    def test_clear_all(self):
        self.cache.put_metadata("abc", {"id": "abc"})
        self.cache.put_json3("abc", "en", "{}")
        self.cache.put_cues("abc", "en", "rule", None, [])

        self.assertEqual(self.cache.clear_all(), 3)
        self.assertEqual(list(self.cache_dir.iterdir()), [])


if __name__ == "__main__":
    unittest.main()
