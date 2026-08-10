"""Tests for the translate module — OpenAI, DeepL, batch, stream."""

import asyncio
import json
import os
import unittest
from unittest.mock import AsyncMock, MagicMock, patch

import httpx

from youtube_ingest.translate import (
    TranslateError,
    translate_batch,
    translate_single,
    translate_stream,
    translate_subtitles,
)


class TranslateSingleTest(unittest.TestCase):
    def test_unknown_provider(self):
        with self.assertRaises(TranslateError) as ctx:
            asyncio.get_event_loop().run_until_complete(
                translate_single("Hello", "en", "zh-CN", provider="nonexistent")
            )
        self.assertIn("Unknown translation provider", str(ctx.exception))


class TranslateErrorTest(unittest.TestCase):
    def test_translate_error_is_runtime_error(self):
        err = TranslateError("test message")
        self.assertIsInstance(err, RuntimeError)

    def test_no_api_key_raises_for_openai(self):
        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaises(TranslateError) as ctx:
                asyncio.get_event_loop().run_until_complete(
                    translate_single("Hello", "en", "zh-CN", provider="openai")
                )
            self.assertIn("TRANSLATE_API_KEY", str(ctx.exception))


class TranslateBatchTest(unittest.TestCase):
    """Test translate_batch and translate_subtitles with explicit provider injection."""

    @staticmethod
    async def _success(text, from_lang, to_lang, **kw):
        return f"TR[{text}]"

    @staticmethod
    async def _partial_fail(text, from_lang, to_lang, **kw):
        if text == "a":
            raise TranslateError("fail-a")
        return f"TR[{text}]"

    def test_batch_success(self):
        from youtube_ingest.translate import TRANSLATE_PROVIDERS
        TRANSLATE_PROVIDERS["_t_"] = self._success
        try:
            r = asyncio.get_event_loop().run_until_complete(
                translate_batch(["x", "y"], "en", "zh-CN", provider="_t_")
            )
            self.assertEqual(r, ["TR[x]", "TR[y]"])
        finally:
            TRANSLATE_PROVIDERS.pop("_t_", None)

    def test_batch_partial_failure(self):
        from youtube_ingest.translate import TRANSLATE_PROVIDERS
        TRANSLATE_PROVIDERS["_t_"] = self._partial_fail
        try:
            r = asyncio.get_event_loop().run_until_complete(
                translate_batch(["a", "b", "a", "c"], "en", "zh-CN", provider="_t_")
            )
            self.assertEqual(r, [
                "[Translation failed]", "TR[b]", "[Translation failed]", "TR[c]",
            ])
        finally:
            TRANSLATE_PROVIDERS.pop("_t_", None)

    def test_batch_empty(self):
        from youtube_ingest.translate import TRANSLATE_PROVIDERS
        TRANSLATE_PROVIDERS["_t_"] = self._success
        try:
            r = asyncio.get_event_loop().run_until_complete(
                translate_batch([], "en", "zh-CN", provider="_t_")
            )
            self.assertEqual(r, [])
        finally:
            TRANSLATE_PROVIDERS.pop("_t_", None)

    def test_translate_subtitles(self):
        from youtube_ingest.translate import TRANSLATE_PROVIDERS
        TRANSLATE_PROVIDERS["_t_"] = self._success
        try:
            subs = [
                {"start": 0, "end": 500, "text": "Hello", "translation": ""},
                {"start": 600, "end": 1200, "text": "world", "translation": ""},
            ]
            r = asyncio.get_event_loop().run_until_complete(
                translate_subtitles(subs, "en", "zh-CN", provider="_t_")
            )
            self.assertEqual(r[0]["translation"], "TR[Hello]")
            self.assertEqual(r[1]["translation"], "TR[world]")
            self.assertEqual(r[0]["start"], 0)
        finally:
            TRANSLATE_PROVIDERS.pop("_t_", None)


class TranslateStreamTest(unittest.TestCase):
    def test_stream_non_openai_falls_back(self):
        from youtube_ingest.translate import TRANSLATE_PROVIDERS

        @staticmethod
        async def fake(text, from_lang, to_lang, **kw):
            return "Hallo"

        TRANSLATE_PROVIDERS["_t_"] = fake
        try:
            chunks = []
            async def collect():
                async for c in translate_stream("Hello", "en", "de", provider="_t_"):
                    chunks.append(c)
            asyncio.get_event_loop().run_until_complete(collect())
            self.assertEqual(chunks, ["Hallo"])
        finally:
            TRANSLATE_PROVIDERS.pop("_t_", None)

    def test_stream_yields_chunks(self):
        class FakeClient:
            def __init__(self, **kw): pass
            async def __aenter__(self): return self
            async def __aexit__(self, *args): pass
            def stream(self, *a, **kw):
                class F:
                    status_code = 200
                    async def aread(self): return b""
                    async def aiter_lines(self):
                        yield 'data: {"choices":[{"delta":{"content":"a"}}]}'
                        yield 'data: {"choices":[{"delta":{"content":"b"}}]}'
                        yield "data: [DONE]"
                    async def __aenter__(self): return self
                    async def __aexit__(self, *a): pass
                return F()

        with patch("youtube_ingest.translate.httpx.AsyncClient", new=FakeClient), \
             patch.dict(os.environ, {"OPENAI_API_KEY": "sk"}):
            chunks = []
            async def collect():
                async for c in translate_stream("H", "en", "zh-CN", provider="openai"):
                    chunks.append(c)
            asyncio.get_event_loop().run_until_complete(collect())
            self.assertEqual(chunks, ["a", "b"])

    def test_stream_error(self):
        class FakeClient:
            def __init__(self, **kw): pass
            async def __aenter__(self): return self
            async def __aexit__(self, *args): pass
            def stream(self, *a, **kw):
                class F:
                    status_code = 401
                    async def aread(self): return b"{}"
                    async def aiter_lines(self): yield ""
                    async def __aenter__(self): return self
                    async def __aexit__(self, *a): pass
                return F()

        with patch("youtube_ingest.translate.httpx.AsyncClient", new=FakeClient), \
             patch.dict(os.environ, {"OPENAI_API_KEY": "sk"}):
            async def collect():
                async for _ in translate_stream("H", "en", "zh-CN", provider="openai"):
                    pass
            with self.assertRaises(TranslateError) as ctx:
                asyncio.get_event_loop().run_until_complete(collect())
            self.assertIn("401", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
