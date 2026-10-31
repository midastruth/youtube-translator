"""Document-mode API boundaries. No real YouTube or model requests."""

import json
import unittest
from unittest.mock import AsyncMock, patch

import httpx
from fastapi.testclient import TestClient

from youtube_ingest.agent_client import AgentWorkerClient, AgentWorkerError
from youtube_ingest.server import app


class DocumentClientTest(unittest.IsolatedAsyncioTestCase):
    async def test_forwards_ephemeral_key_engine_and_model_limits(self):
        captured = {}

        def handle(request):
            captured.update(json.loads(request.content))
            return httpx.Response(200, json={"job_id": "document-job"})

        client = httpx.AsyncClient(transport=httpx.MockTransport(handle))
        with patch("youtube_ingest.agent_client.httpx.AsyncClient", return_value=client):
            response = await AgentWorkerClient().submit_or_attach(
                cues=[{"start": 123, "end": 456, "text": "Hello"}],
                video_id="v", title="Title", from_lang="en", to_lang="zh-CN",
                engine="document", api_key="ephemeral-key", context_tokens=64000, output_tokens=8000,
            )
        self.assertEqual(response["job_id"], "document-job")
        self.assertEqual(captured["engine"], "document")
        self.assertEqual(captured["apiKey"], "ephemeral-key")
        self.assertEqual(captured["contextTokens"], 64000)
        self.assertEqual(captured["outputTokens"], 8000)

    async def test_connection_errors_explain_how_to_start_worker(self):
        def handle(request):
            raise httpx.ConnectError("offline", request=request)

        client = httpx.AsyncClient(transport=httpx.MockTransport(handle))
        with patch("youtube_ingest.agent_client.httpx.AsyncClient", return_value=client):
            with self.assertRaisesRegex(AgentWorkerError, "npm run worker"):
                await AgentWorkerClient().submit_or_attach(
                    cues=[], video_id="v", title="", from_lang="en", to_lang="zh-CN", engine="document",
                )


class DocumentStreamTest(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)
        self.request = {
            "url": "https://www.youtube.com/watch?v=fixture", "translate_engine": "document",
            "translate_to": "zh-CN", "translate_api_key": "browser-key",
        }
        self.meta = {"video_id": "v", "title": "Title", "from_lang": "en", "source": "browser"}
        self.cues = [{"start": 123, "end": 1200, "text": "A database transaction."}]

    def test_stream_forwards_progress_and_final_cues_without_legacy_translation(self):
        async def stream(_job_id):
            for event in [
                {"type": "meta", "total_cues": 1},
                {"type": "progress", "stage": "review", "progress": "1"},
                {"type": "cue", "index": 0, **self.cues[0], "translation": "一个数据库事务。"},
                {"type": "done", "total_cues": 1, "failed_cues": 0},
            ]:
                yield event

        with (
            patch("youtube_ingest.server._process_subtitle_sync", return_value=(self.meta, self.cues)),
            patch("youtube_ingest.server.AgentWorkerClient") as worker,
            patch("youtube_ingest.server.translate_subtitles", new_callable=AsyncMock) as legacy,
        ):
            worker.return_value.submit_or_attach = AsyncMock(return_value={"job_id": "doc-job"})
            worker.return_value.stream_job = stream
            response = self.client.post("/api/subtitle/stream", json=self.request)
            self.assertEqual(response.status_code, 200)
            events = [json.loads(line[6:]) for line in response.text.splitlines() if line.startswith("data: ")]
            self.assertEqual(events[1]["stage"], "review")
            self.assertEqual(events[-1]["type"], "done")
            self.assertEqual(worker.return_value.submit_or_attach.call_args.kwargs["engine"], "document")
            self.assertEqual(worker.return_value.submit_or_attach.call_args.kwargs["api_key"], "browser-key")
            legacy.assert_not_called()

    def test_worker_unavailable_is_an_error_not_sentence_fallback(self):
        with (
            patch("youtube_ingest.server._process_subtitle_sync", return_value=(self.meta, self.cues)),
            patch("youtube_ingest.server.AgentWorkerClient") as worker,
            patch("youtube_ingest.server.translate_subtitles", new_callable=AsyncMock) as legacy,
        ):
            worker.return_value.submit_or_attach = AsyncMock(side_effect=AgentWorkerError("offline"))
            response = self.client.post("/api/subtitle/stream", json=self.request)
            self.assertEqual(response.status_code, 503)
            legacy.assert_not_called()

    def test_removed_agent_engine_is_rejected_before_ingestion(self):
        with patch("youtube_ingest.server._process_subtitle_sync") as ingest:
            for route in ("/api/subtitle/process", "/api/subtitle/stream"):
                response = self.client.post(route, json={**self.request, "translate_engine": "agent"})
                self.assertEqual(response.status_code, 422)
            ingest.assert_not_called()

    def test_document_mode_rejects_legacy_rest_and_sentence_only_provider(self):
        self.assertEqual(self.client.post("/api/subtitle/process", json=self.request).status_code, 422)
        with patch("youtube_ingest.server._process_subtitle_sync", return_value=(self.meta, self.cues)):
            response = self.client.post("/api/subtitle/stream", json={**self.request, "translate_provider": "deepl"})
            self.assertEqual(response.status_code, 422)
