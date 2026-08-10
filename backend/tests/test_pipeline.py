"""Tests for the pipeline, audio, and transcribe modules."""

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from youtube_ingest.errors import IngestError


class PipelineSafeNameTest(unittest.TestCase):
    def test_safe_name_strips_unsafe(self):
        from youtube_ingest.pipeline import _safe_name
        self.assertEqual(_safe_name("Hello World!"), "Hello-World")
        self.assertEqual(_safe_name("  test  "), "test")

    def test_safe_name_truncates(self):
        from youtube_ingest.pipeline import _safe_name
        long = "a" * 100
        result = _safe_name(long)
        self.assertLessEqual(len(result), 80)

    def test_safe_name_empty(self):
        from youtube_ingest.pipeline import _safe_name
        self.assertEqual(_safe_name("."), "video")  # strip dots then empty => video


class PipelinePublicMetadataTest(unittest.TestCase):
    def test_filters_fields(self):
        from youtube_ingest.pipeline import _public_metadata
        raw = {
            "id": "abc",
            "title": "Test",
            "secret_field": "should not appear",
            "description": "desc",
            "channel": "ch",
            "channel_id": "ch123",
            "uploader": "up",
            "upload_date": "20240101",
            "duration": 120,
            "webpage_url": "https://...",
            "thumbnail": "thumb.jpg",
            "view_count": 1000,
            "like_count": 50,
            "categories": ["Music"],
            "tags": ["tag1"],
        }
        result = _public_metadata(raw)
        self.assertNotIn("secret_field", result)
        self.assertEqual(result["id"], "abc")
        self.assertEqual(result["title"], "Test")
        self.assertEqual(result["view_count"], 1000)


class PipelineIngestTest(unittest.TestCase):
    def test_ingest_result_dataclass(self):
        from youtube_ingest.pipeline import IngestResult
        r = IngestResult(
            video_id="abc",
            title="Test",
            mode="subtitle:manual",
            subtitle_language="en",
            metadata_path="/tmp/meta.json",
            transcript_path="/tmp/transcript.txt",
        )
        self.assertEqual(r.video_id, "abc")
        self.assertEqual(r.mode, "subtitle:manual")

        d = dict(
            video_id=r.video_id, title=r.title, mode=r.mode,
            subtitle_language=r.subtitle_language,
            metadata_path=r.metadata_path, transcript_path=r.transcript_path,
        )
        self.assertEqual(d["video_id"], "abc")


class AudioTest(unittest.TestCase):
    def test_split_audio_invalid_chunk_seconds(self):
        from youtube_ingest.audio import split_audio
        with self.assertRaises(IngestError) as ctx:
            split_audio(Path("/tmp/test.mp3"), Path("/tmp/chunks"), chunk_seconds=0)
        self.assertIn("greater than zero", str(ctx.exception))

        with self.assertRaises(IngestError):
            split_audio(Path("/tmp/test.mp3"), Path("/tmp/chunks"), chunk_seconds=-1)

    @patch("youtube_ingest.audio.shutil.which", return_value="/usr/bin/ffmpeg")
    def test_ensure_ffmpeg_found(self, mock_which):
        from youtube_ingest.audio import ensure_ffmpeg
        ensure_ffmpeg()  # should not raise

    @patch("youtube_ingest.audio.shutil.which", return_value=None)
    def test_ensure_ffmpeg_not_found(self, mock_which):
        from youtube_ingest.audio import ensure_ffmpeg
        with self.assertRaises(IngestError) as ctx:
            ensure_ffmpeg()
        self.assertIn("ffmpeg", str(ctx.exception))

    @patch("youtube_ingest.audio.shutil.which", return_value="/usr/bin/ffmpeg")
    @patch("youtube_ingest.audio.subprocess.run")
    def test_split_audio_success(self, mock_run, mock_which):
        from youtube_ingest.audio import split_audio
        with tempfile.TemporaryDirectory() as tmp:
            chunks_dir = Path(tmp) / "chunks"
            audio_path = Path(tmp) / "audio.mp3"
            audio_path.write_bytes(b"fake audio")

            # Create chunk files to simulate ffmpeg output
            chunks_dir.mkdir()
            (chunks_dir / "chunk_001.mp3").write_bytes(b"chunk 1")
            (chunks_dir / "chunk_002.mp3").write_bytes(b"chunk 2")

            result = split_audio(audio_path, chunks_dir, chunk_seconds=600)
            self.assertEqual(len(result), 2)

    @patch("youtube_ingest.audio.shutil.which", return_value="/usr/bin/ffmpeg")
    @patch("youtube_ingest.audio.subprocess.run")
    def test_split_audio_no_chunks_produced(self, mock_run, mock_which):
        from youtube_ingest.audio import split_audio
        with tempfile.TemporaryDirectory() as tmp:
            chunks_dir = Path(tmp) / "chunks"
            audio_path = Path(tmp) / "audio.mp3"
            audio_path.write_bytes(b"fake audio")
            chunks_dir.mkdir()  # empty dir

            with self.assertRaises(IngestError) as ctx:
                split_audio(audio_path, chunks_dir)
            self.assertIn("did not produce", str(ctx.exception))

    @patch("youtube_ingest.audio.shutil.which", return_value="/usr/bin/ffmpeg")
    @patch("youtube_ingest.audio.subprocess.run")
    def test_split_audio_ffmpeg_failure(self, mock_run, mock_which):
        from youtube_ingest.audio import split_audio
        import subprocess
        mock_run.side_effect = subprocess.CalledProcessError(1, "ffmpeg", stderr=b"error")

        with tempfile.TemporaryDirectory() as tmp:
            chunks_dir = Path(tmp) / "chunks"
            audio_path = Path(tmp) / "audio.mp3"
            audio_path.write_bytes(b"fake")

            with self.assertRaises(IngestError) as ctx:
                split_audio(audio_path, chunks_dir)
            self.assertIn("ffmpeg failed", str(ctx.exception))


class TranscribeTest(unittest.TestCase):
    def test_whisper_client_no_api_key(self):
        from youtube_ingest.transcribe import WhisperClient
        with patch.dict("os.environ", {}, clear=True):
            with self.assertRaises(IngestError) as ctx:
                WhisperClient()
            self.assertIn("WHISPER_API_KEY", str(ctx.exception))

    def test_whisper_client_defaults(self):
        from youtube_ingest.transcribe import WhisperClient
        client = WhisperClient(api_key="test-key")
        self.assertEqual(client.model, "whisper-large-v3")
        self.assertEqual(client.base_url, "https://api.groq.com/openai/v1")
        self.assertEqual(client.timeout_seconds, 180.0)
        self.assertEqual(client.retries, 3)

    def test_whisper_client_custom(self):
        from youtube_ingest.transcribe import WhisperClient
        client = WhisperClient(
            api_key="key",
            base_url="https://custom.api/v1",
            model="whisper-1",
            timeout_seconds=60.0,
            retries=1,
        )
        self.assertEqual(client.model, "whisper-1")
        self.assertEqual(client.base_url, "https://custom.api/v1")

    @patch("httpx.post")
    def test_transcribe_success(self, mock_post):
        from youtube_ingest.transcribe import WhisperClient
        mock_resp = MagicMock()
        mock_resp.json.return_value = {"text": "Hello world"}
        mock_resp.raise_for_status.return_value = None
        mock_post.return_value = mock_resp

        client = WhisperClient(api_key="test-key")
        with tempfile.TemporaryDirectory() as tmp:
            audio_path = Path(tmp) / "audio.mp3"
            audio_path.write_bytes(b"fake audio")
            result = client.transcribe(audio_path)
            self.assertEqual(result, "Hello world")

    @patch("httpx.post")
    def test_transcribe_empty_response(self, mock_post):
        from youtube_ingest.transcribe import WhisperClient
        mock_resp = MagicMock()
        mock_resp.json.return_value = {"text": "  "}
        mock_resp.raise_for_status.return_value = None
        mock_post.return_value = mock_resp

        client = WhisperClient(api_key="test-key", retries=1)
        with tempfile.TemporaryDirectory() as tmp:
            audio_path = Path(tmp) / "audio.mp3"
            audio_path.write_bytes(b"fake")
            with self.assertRaises(IngestError) as ctx:
                client.transcribe(audio_path)
            self.assertIn("returned no text", str(ctx.exception))

    @patch("httpx.post")
    def test_transcribe_retry_then_success(self, mock_post):
        from youtube_ingest.transcribe import WhisperClient
        import httpx as _httpx
        fail_resp = MagicMock()
        fail_resp.raise_for_status.side_effect = _httpx.HTTPStatusError(
            "timeout", request=MagicMock(), response=MagicMock(status_code=503)
        )
        ok_resp = MagicMock()
        ok_resp.json.return_value = {"text": "It worked"}
        ok_resp.raise_for_status.return_value = None
        mock_post.side_effect = [fail_resp, ok_resp]

        client = WhisperClient(api_key="test-key", retries=3)
        with tempfile.TemporaryDirectory() as tmp:
            audio_path = Path(tmp) / "audio.mp3"
            audio_path.write_bytes(b"fake")
            with patch("time.sleep") as mock_sleep:
                result = client.transcribe(audio_path)
                self.assertEqual(result, "It worked")
                self.assertEqual(mock_post.call_count, 2)

    @patch("httpx.post")
    def test_transcribe_all_retries_fail(self, mock_post):
        from youtube_ingest.transcribe import WhisperClient
        import httpx as _httpx
        mock_resp = MagicMock()
        mock_resp.raise_for_status.side_effect = _httpx.HTTPStatusError(
            "boom", request=MagicMock(), response=MagicMock(status_code=500)
        )
        mock_post.return_value = mock_resp

        client = WhisperClient(api_key="test-key", retries=2)
        with tempfile.TemporaryDirectory() as tmp:
            audio_path = Path(tmp) / "audio.mp3"
            audio_path.write_bytes(b"fake")
            with patch("time.sleep"):
                with self.assertRaises(IngestError) as ctx:
                    client.transcribe(audio_path)
                self.assertIn("transcription failed", str(ctx.exception))
                self.assertEqual(mock_post.call_count, 2)

    def test_transcribe_chunks(self):
        from youtube_ingest.transcribe import WhisperClient, transcribe_chunks
        client = MagicMock()
        client.transcribe.return_value = "Hello"

        with tempfile.TemporaryDirectory() as tmp:
            transcripts_dir = Path(tmp) / "transcripts"
            chunks = [Path(tmp) / "chunk_001.mp3", Path(tmp) / "chunk_002.mp3"]
            for c in chunks:
                c.write_bytes(b"fake")

            result = transcribe_chunks(chunks, transcripts_dir, client, language="en")
            self.assertEqual(len(result), 2)
            self.assertEqual(client.transcribe.call_count, 2)

    def test_merge_transcripts(self):
        from youtube_ingest.transcribe import merge_transcripts
        with tempfile.TemporaryDirectory() as tmp:
            p1 = Path(tmp) / "a.txt"
            p2 = Path(tmp) / "b.txt"
            p1.write_text("Hello\n", encoding="utf-8")
            p2.write_text("World\n", encoding="utf-8")
            dest = Path(tmp) / "merged.txt"

            merge_transcripts([p1, p2], dest)
            self.assertEqual(dest.read_text(encoding="utf-8"), "Hello\n\nWorld\n")

    def test_merge_transcripts_skips_empty(self):
        from youtube_ingest.transcribe import merge_transcripts
        with tempfile.TemporaryDirectory() as tmp:
            p1 = Path(tmp) / "a.txt"
            p2 = Path(tmp) / "b.txt"
            p1.write_text("A", encoding="utf-8")
            p2.write_text("  ", encoding="utf-8")  # whitespace only
            dest = Path(tmp) / "merged.txt"

            merge_transcripts([p1, p2], dest)
            self.assertEqual(dest.read_text(encoding="utf-8"), "A\n")


class ErrorsTest(unittest.TestCase):
    def test_ingest_error(self):
        err = IngestError("something went wrong")
        self.assertIsInstance(err, RuntimeError)
        self.assertEqual(str(err), "something went wrong")


class WhisperClientEnvTest(unittest.TestCase):
    def test_env_priority(self):
        from youtube_ingest.transcribe import WhisperClient
        with patch.dict("os.environ", {
            "WHISPER_API_KEY": "key-a",
            "GROQ_API_KEY": "key-b",
        }):
            client = WhisperClient()
            self.assertEqual(client.api_key, "key-a")  # WHISPER_API_KEY wins

    def test_groq_fallback(self):
        from youtube_ingest.transcribe import WhisperClient
        with patch.dict("os.environ", {"GROQ_API_KEY": "groq-key"}, clear=True):
            client = WhisperClient()
            self.assertEqual(client.api_key, "groq-key")

    def test_env_base_url(self):
        from youtube_ingest.transcribe import WhisperClient
        with patch.dict("os.environ", {
            "WHISPER_API_KEY": "key",
            "WHISPER_BASE_URL": "https://my.api/v1",
        }):
            client = WhisperClient()
            self.assertEqual(client.base_url, "https://my.api/v1")

    def test_env_model(self):
        from youtube_ingest.transcribe import WhisperClient
        with patch.dict("os.environ", {
            "WHISPER_API_KEY": "key",
            "WHISPER_MODEL": "whisper-large-v3-turbo",
        }):
            client = WhisperClient()
            self.assertEqual(client.model, "whisper-large-v3-turbo")


if __name__ == "__main__":
    unittest.main()
