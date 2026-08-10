"""Tests for the server module — FastAPI endpoints and WebSocket."""

import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

from youtube_ingest.errors import IngestError


class ServerEndpointsTest(unittest.TestCase):
    """Test server FastAPI endpoints via TestClient."""

    @classmethod
    def setUpClass(cls):
        # We need httpx for the TestClient
        try:
            from fastapi.testclient import TestClient
            cls._has_testclient = True
        except ImportError:
            cls._has_testclient = False

    def setUp(self):
        if not self._has_testclient:
            self.skipTest("fastapi.testclient not available")

    def test_health_endpoint(self):
        from youtube_ingest.server import app
        from fastapi.testclient import TestClient
        client = TestClient(app)
        resp = client.get("/api/health")
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertEqual(data["status"], "ok")
        self.assertIn("version", data)

    def test_tracks_endpoint_requires_url(self):
        from youtube_ingest.server import app
        from fastapi.testclient import TestClient
        client = TestClient(app)
        resp = client.get("/api/subtitle/tracks")
        self.assertEqual(resp.status_code, 422)  # missing required param

    @patch("youtube_ingest.server.fetch_metadata")
    def test_tracks_endpoint_returns_tracks(self, mock_fetch):
        from youtube_ingest.server import app
        from fastapi.testclient import TestClient
        mock_fetch.return_value = {
            "id": "test123",
            "title": "Test Video",
            "subtitles": {"en": [{}], "zh-Hans": [{}]},
            "automatic_captions": {"en": [{}]},
        }

        client = TestClient(app)
        resp = client.get("/api/subtitle/tracks?url=https://www.youtube.com/watch?v=test123")
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertEqual(data["video_id"], "test123")
        self.assertEqual(data["title"], "Test Video")
        # Should have manual en, manual zh-Hans, and auto en
        en_tracks = [t for t in data["tracks"] if t["language"] == "en"]
        zh_tracks = [t for t in data["tracks"] if t["language"] == "zh-Hans"]
        self.assertGreaterEqual(len(en_tracks), 1)
        self.assertGreaterEqual(len(zh_tracks), 1)
        self.assertIn("manual", {t["source"] for t in en_tracks})
        self.assertIn("manual", {t["source"] for t in zh_tracks})

    @patch("youtube_ingest.server.fetch_metadata")
    def test_tracks_endpoint_no_matching_langs(self, mock_fetch):
        from youtube_ingest.server import app
        from fastapi.testclient import TestClient
        mock_fetch.return_value = {
            "id": "test123",
            "title": "Test",
            "subtitles": {"en": [{}]},
            "automatic_captions": {},
        }

        client = TestClient(app)
        resp = client.get(
            "/api/subtitle/tracks?url=https://www.youtube.com/watch?v=test123"
            "&languages=ja,ko"
        )
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertEqual(len(data["tracks"]), 0)

    @patch("youtube_ingest.server.fetch_metadata")
    def test_tracks_endpoint_ytdlp_error(self, mock_fetch):
        from youtube_ingest.server import app
        from fastapi.testclient import TestClient
        mock_fetch.side_effect = IngestError("yt-dlp crashed")

        client = TestClient(app)
        resp = client.get("/api/subtitle/tracks?url=https://www.youtube.com/watch?v=bad")
        self.assertEqual(resp.status_code, 400)
        self.assertIn("yt-dlp crashed", resp.json()["detail"])


class ServerProcessTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        try:
            from fastapi.testclient import TestClient
            cls._has_testclient = True
        except ImportError:
            cls._has_testclient = False

    def setUp(self):
        if not self._has_testclient:
            self.skipTest("fastapi.testclient not available")

    @patch("youtube_ingest.server._cache")
    @patch("youtube_ingest.server._fetch_json3_subtitle")
    @patch("youtube_ingest.server.fetch_metadata")
    def test_process_endpoint_no_translate(self, mock_fetch, mock_json3, mock_cache):
        from youtube_ingest.server import app
        from fastapi.testclient import TestClient

        mock_fetch.return_value = {
            "id": "test123",
            "title": "Test Video",
            "subtitles": {"en": [{}]},
            "automatic_captions": {},
        }
        mock_json3.return_value = json.dumps({
            "events": [
                {"tStartMs": 0, "dDurationMs": 500, "segs": [{"utf8": "Hi there.", "tOffsetMs": 0}]},
            ]
        })
        mock_cache.get_cues.return_value = None
        mock_cache.get_json3.return_value = None

        client = TestClient(app)
        resp = client.post("/api/subtitle/process", json={
            "url": "https://www.youtube.com/watch?v=test123",
            "languages": ["en"],
            "segmentation": "rule",
        })
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertEqual(data["video_id"], "test123")
        self.assertEqual(data["from_lang"], "en")
        self.assertEqual(data["source"], "manual")
        self.assertEqual(len(data["cues"]), 1)
        self.assertEqual(data["cues"][0]["text"], "Hi there.")
        self.assertEqual(data["progress"], 100)

    @patch("youtube_ingest.server._cache")
    @patch("youtube_ingest.server._fetch_json3_subtitle")
    @patch("youtube_ingest.server.fetch_metadata")
    def test_process_endpoint_statistical(self, mock_fetch, mock_json3, mock_cache):
        from youtube_ingest.server import app
        from fastapi.testclient import TestClient

        mock_fetch.return_value = {
            "id": "test123",
            "title": "Test",
            "subtitles": {"en": [{}]},
            "automatic_captions": {},
        }
        mock_json3.return_value = json.dumps({
            "events": [
                {"tStartMs": 0, "dDurationMs": 1000, "segs": [
                    {"utf8": "Hello", "tOffsetMs": 0},
                    {"utf8": " world.", "tOffsetMs": 100},
                ]},
                {"tStartMs": 1200, "dDurationMs": 1500, "segs": [
                    {"utf8": "This", "tOffsetMs": 0},
                    {"utf8": " is", "tOffsetMs": 100},
                    {"utf8": " good.", "tOffsetMs": 200},
                ]},
            ]
        })
        mock_cache.get_cues.return_value = None
        mock_cache.get_json3.return_value = None

        client = TestClient(app)
        resp = client.post("/api/subtitle/process", json={
            "url": "https://www.youtube.com/watch?v=test123",
            "languages": ["en"],
            "segmentation": "statistical",
        })
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertEqual(data["segmentation"], "statistical")
        self.assertGreater(len(data["cues"]), 0)

    @patch("youtube_ingest.server._cache")
    @patch("youtube_ingest.server._fetch_json3_subtitle")
    @patch("youtube_ingest.server.fetch_metadata")
    def test_process_endpoint_cache_hit(self, mock_fetch, mock_json3, mock_cache):
        from youtube_ingest.server import app
        from fastapi.testclient import TestClient

        mock_fetch.return_value = {
            "id": "test123",
            "title": "Test",
            "subtitles": {"en": [{}]},
            "automatic_captions": {},
        }
        mock_cache.get_cues.return_value = [
            {"start": 0, "end": 500, "text": "Cached", "translation": ""}
        ]

        client = TestClient(app)
        resp = client.post("/api/subtitle/process", json={
            "url": "https://www.youtube.com/watch?v=test123",
            "languages": ["en"],
            "segmentation": "rule",
        })
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertEqual(data["cues"][0]["text"], "Cached")
        # json3 should NOT have been fetched
        mock_json3.assert_not_called()

    @patch("youtube_ingest.server._cache")
    @patch("youtube_ingest.server._fetch_json3_subtitle")
    @patch("youtube_ingest.server.fetch_metadata")
    def test_process_endpoint_recovers_invalid_json3_cache(
        self, mock_fetch, mock_json3, mock_cache,
    ):
        from youtube_ingest.server import app
        from fastapi.testclient import TestClient

        mock_fetch.return_value = {
            "id": "test123",
            "title": "Test",
            "subtitles": {"en": [{}]},
            "automatic_captions": {},
        }
        mock_cache.get_cues.return_value = None
        mock_cache.get_json3.return_value = "not-json"
        valid_json3 = json.dumps({
            "events": [
                {"tStartMs": 0, "dDurationMs": 500,
                 "segs": [{"utf8": "Recovered.", "tOffsetMs": 0}]},
            ]
        })
        mock_json3.return_value = valid_json3

        client = TestClient(app)
        resp = client.post("/api/subtitle/process", json={
            "url": "https://www.youtube.com/watch?v=test123",
            "languages": ["en"],
        })

        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json()["cues"][0]["text"], "Recovered.")
        mock_json3.assert_called_once()
        mock_cache.put_json3.assert_called_once_with("test123", "en", valid_json3)

    @patch("youtube_ingest.server._cache")
    @patch("youtube_ingest.server._fetch_json3_subtitle")
    @patch("youtube_ingest.server.fetch_metadata")
    def test_process_endpoint_no_subtitle_available(self, mock_fetch, mock_json3, mock_cache):
        from youtube_ingest.server import app
        from fastapi.testclient import TestClient

        mock_fetch.return_value = {
            "id": "test123",
            "title": "Test",
            "subtitles": {},
            "automatic_captions": {},
        }
        mock_cache.get_cues.return_value = None

        client = TestClient(app)
        resp = client.post("/api/subtitle/process", json={
            "url": "https://www.youtube.com/watch?v=test123",
            "languages": ["en"],
        })
        self.assertEqual(resp.status_code, 404)
        self.assertIn("No matching subtitle", resp.json()["detail"])

    @patch("youtube_ingest.server._cache")
    @patch("youtube_ingest.server._fetch_json3_subtitle")
    @patch("youtube_ingest.server.fetch_metadata")
    def test_process_with_translate(self, mock_fetch, mock_json3, mock_cache):
        from youtube_ingest.server import app
        from fastapi.testclient import TestClient

        mock_fetch.return_value = {
            "id": "test123",
            "title": "Test",
            "subtitles": {"en": [{}]},
            "automatic_captions": {},
        }
        mock_json3.return_value = json.dumps({
            "events": [
                {"tStartMs": 0, "dDurationMs": 500, "segs": [{"utf8": "Hello", "tOffsetMs": 0}]},
            ]
        })
        mock_cache.get_cues.return_value = None
        mock_cache.get_json3.return_value = None

        client = TestClient(app)
        with patch("youtube_ingest.server.translate_subtitles", new_callable=AsyncMock) as mock_tr:
            mock_tr.return_value = [
                {"start": 0, "end": 500, "text": "Hello", "translation": "你好"}
            ]
            resp = client.post("/api/subtitle/process", json={
                "url": "https://www.youtube.com/watch?v=test123",
                "languages": ["en"],
                "segmentation": "rule",
                "translate_to": "zh-CN",
                "translate_provider": "openai",
                "translate_api_key": "sk-test",
                "translate_model": "gpt-4",
            })
            self.assertEqual(resp.status_code, 200)
            data = resp.json()
            self.assertEqual(data["to_lang"], "zh-CN")
            self.assertEqual(data["cues"][0]["translation"], "你好")
            mock_tr.assert_called_once()

    @patch("youtube_ingest.server._cache")
    @patch("youtube_ingest.server._fetch_json3_subtitle")
    @patch("youtube_ingest.server.fetch_metadata")
    def test_process_translate_failure_returns_untranslated(self, mock_fetch, mock_json3, mock_cache):
        from youtube_ingest.server import app
        from fastapi.testclient import TestClient

        mock_fetch.return_value = {
            "id": "test123",
            "title": "Test",
            "subtitles": {"en": [{}]},
            "automatic_captions": {},
        }
        mock_json3.return_value = json.dumps({
            "events": [
                {"tStartMs": 0, "dDurationMs": 500, "segs": [{"utf8": "Hello", "tOffsetMs": 0}]},
            ]
        })
        mock_cache.get_cues.return_value = None
        mock_cache.get_json3.return_value = None

        client = TestClient(app)
        with patch("youtube_ingest.server.translate_subtitles", new_callable=AsyncMock) as mock_tr:
            mock_tr.side_effect = Exception("API is down")
            resp = client.post("/api/subtitle/process", json={
                "url": "https://www.youtube.com/watch?v=test123",
                "languages": ["en"],
                "segmentation": "rule",
                "translate_to": "zh-CN",
            })
            self.assertEqual(resp.status_code, 200)
            data = resp.json()
            self.assertEqual(data["to_lang"], "zh-CN")
            self.assertEqual(len(data["cues"]), 1)
            self.assertEqual(data["cues"][0]["translation"], "")


class ServerSSETest(unittest.TestCase):
    @staticmethod
    def collect_stream(req):
        from youtube_ingest.server import process_subtitle_stream

        async def collect():
            response = await process_subtitle_stream(req)
            chunks = []
            async for chunk in response.body_iterator:
                chunks.append(chunk.decode() if isinstance(chunk, bytes) else chunk)
            return response, "".join(chunks)

        return asyncio.run(collect())

    @patch("youtube_ingest.server.run_in_threadpool", new_callable=AsyncMock)
    def test_stream_no_translate_returns_all_cues(self, mock_process):
        from youtube_ingest.server import SubtitleRequest

        mock_process.return_value = ({
            "video_id": "test123", "title": "Test",
            "from_lang": "en", "source": "manual",
        }, [
            {"start": 0, "end": 500, "text": "A.", "translation": ""},
            {"start": 600, "end": 1100, "text": "B.", "translation": ""},
        ])

        resp, body = self.collect_stream(SubtitleRequest(
            url="https://www.youtube.com/watch?v=test123",
            languages=["en"], segmentation="rule",
        ))
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.media_type, "text/event-stream")
        self.assertIn('"type": "meta"', body)
        self.assertIn('"total_cues": 2', body)
        self.assertIn('"type": "cue"', body)
        self.assertIn('"type":"done"', body)
        # Should have at least 2 cues
        cue_chunks = [l for l in body.split("\n") if '"type": "cue"' in l]
        self.assertGreaterEqual(len(cue_chunks), 2)

    @patch("youtube_ingest.server._cache")
    @patch("youtube_ingest.server.run_in_threadpool", new_callable=AsyncMock)
    def test_stream_with_translate(self, mock_process, mock_cache):
        from youtube_ingest.server import SubtitleRequest

        mock_process.return_value = ({
            "video_id": "test123", "title": "Test",
            "from_lang": "en", "source": "manual",
        }, [
            {"start": 0, "end": 500, "text": "Hello.", "translation": ""},
        ])
        mock_cache.get_cues.return_value = None

        with patch(
            "youtube_ingest.server.translate_subtitles", new_callable=AsyncMock,
        ) as mock_translate:
            mock_translate.return_value = [
                {"start": 0, "end": 500, "text": "Hello.", "translation": "你好。"},
            ]
            resp, body = self.collect_stream(SubtitleRequest(
                url="https://www.youtube.com/watch?v=test123",
                languages=["en"], segmentation="rule",
                translate_to="zh-CN", translate_provider="openai",
                translate_api_key="sk-test", translate_whole=True,
            ))
            self.assertEqual(resp.status_code, 200)
            self.assertIn('"type": "source_cue"', body)
            self.assertIn('"type": "cue"', body)
            self.assertIn("你好。", body)
            self.assertIn('"failed_cues": 0', body)
            self.assertTrue(mock_translate.await_args.kwargs["whole"])


class ServerCacheAdminTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        try:
            from fastapi.testclient import TestClient
            cls._has_testclient = True
        except ImportError:
            cls._has_testclient = False

    def setUp(self):
        if not self._has_testclient:
            self.skipTest("fastapi.testclient not available")

    @patch("youtube_ingest.server._cache")
    def test_clear_video_cache(self, mock_cache):
        from youtube_ingest.server import app
        from fastapi.testclient import TestClient

        mock_cache.clear_video.return_value = 5
        client = TestClient(app)
        resp = client.delete("/api/cache/abc123")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json()["removed"], 5)
        mock_cache.clear_video.assert_called_once_with("abc123")

    @patch("youtube_ingest.server._cache")
    def test_purge_cache(self, mock_cache):
        from youtube_ingest.server import app
        from fastapi.testclient import TestClient

        mock_cache.purge_expired.return_value = 12
        client = TestClient(app)
        resp = client.post("/api/cache/purge")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json()["removed"], 12)


class ServerErrorHandlingTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        try:
            from fastapi.testclient import TestClient
            cls._has_testclient = True
        except ImportError:
            cls._has_testclient = False

    def setUp(self):
        if not self._has_testclient:
            self.skipTest("fastapi.testclient not available")

    @patch("youtube_ingest.server.fetch_metadata")
    def test_process_endpoint_invalid_url(self, mock_fetch):
        from youtube_ingest.server import app
        from fastapi.testclient import TestClient
        mock_fetch.side_effect = IngestError("Invalid URL")

        client = TestClient(app)
        resp = client.post("/api/subtitle/process", json={
            "url": "not-a-valid-url",
            "languages": ["en"],
        })
        self.assertEqual(resp.status_code, 400)

    @patch("youtube_ingest.server.fetch_metadata")
    def test_process_endpoint_unexpected_error(self, mock_fetch):
        from youtube_ingest.server import app
        from fastapi.testclient import TestClient
        mock_fetch.side_effect = RuntimeError("Something weird happened")

        client = TestClient(app)
        resp = client.post("/api/subtitle/process", json={
            "url": "https://www.youtube.com/watch?v=test",
            "languages": ["en"],
        })
        self.assertEqual(resp.status_code, 500)

    @patch("youtube_ingest.server.fetch_metadata")
    def test_tracks_endpoint_unexpected_error(self, mock_fetch):
        from youtube_ingest.server import app
        from fastapi.testclient import TestClient
        mock_fetch.side_effect = OSError("Disk full")

        client = TestClient(app)
        resp = client.get("/api/subtitle/tracks?url=https://www.youtube.com/watch?v=test")
        self.assertEqual(resp.status_code, 500)


class ServerResponseModelTest(unittest.TestCase):
    def test_default_languages_in_request(self):
        from youtube_ingest.server import SubtitleRequest
        req = SubtitleRequest(url="https://www.youtube.com/watch?v=test")
        self.assertEqual(req.languages, ["zh-Hans", "zh-Hant", "zh", "en"])
        self.assertEqual(req.segmentation, "rule")
        self.assertTrue(req.allow_automatic)

    def test_cue_model(self):
        from youtube_ingest.server import SubtitleCue
        cue = SubtitleCue(start=0.0, end=500.0, text="Hello", translation="你好")
        self.assertEqual(cue.text, "Hello")
        self.assertEqual(cue.translation, "你好")

    def test_subtitle_response_model(self):
        from youtube_ingest.server import SubtitleResponse
        resp = SubtitleResponse(
            video_id="abc",
            title="Test",
            from_lang="en",
            to_lang="zh-CN",
            segmentation="rule",
            source="manual",
            cues=[{"start": 0, "end": 500, "text": "Hello", "translation": "你好"}],
        )
        self.assertEqual(resp.video_id, "abc")
        self.assertEqual(resp.progress, 100)

    def test_health_response(self):
        from youtube_ingest.server import HealthResponse
        h = HealthResponse()
        self.assertEqual(h.status, "ok")
        self.assertEqual(h.version, "0.2.0")


if __name__ == "__main__":
    unittest.main()
