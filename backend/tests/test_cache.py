"""Tests for SubtitleCache — disk-backed cache layer."""

import json
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


if __name__ == "__main__":
    unittest.main()
