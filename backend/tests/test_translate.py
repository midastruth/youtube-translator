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
    _build_whole_prompt,
    _parse_whole_response,
    _WHOLE_TRANSLATE_SYSTEM_PROMPT,
)


class TranslateSingleTest(unittest.TestCase):
    def test_unknown_provider(self):
        with self.assertRaises(TranslateError) as ctx:
            asyncio.run(
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
                asyncio.run(
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
            r = asyncio.run(
                translate_batch(["x", "y"], "en", "zh-CN", provider="_t_")
            )
            self.assertEqual(r, ["TR[x]", "TR[y]"])
        finally:
            TRANSLATE_PROVIDERS.pop("_t_", None)

    def test_batch_partial_failure(self):
        from youtube_ingest.translate import TRANSLATE_PROVIDERS
        TRANSLATE_PROVIDERS["_t_"] = self._partial_fail
        try:
            r = asyncio.run(
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
            r = asyncio.run(
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
            r = asyncio.run(
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
            asyncio.run(collect())
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
            asyncio.run(collect())
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
                asyncio.run(collect())
            self.assertIn("401", str(ctx.exception))


class TranslateWholeTest(unittest.TestCase):
    """Test the whole-transcript (全文一次性翻译) path."""

    def test_build_whole_prompt(self):
        subs = [
            {"start": 0, "end": 500, "text": "Hello world."},
            {"start": 600, "end": 1200, "text": "This is a test."},
        ]
        prompt = _build_whole_prompt(subs)
        self.assertIn("[$0] Hello world.", prompt)
        self.assertIn("[$1] This is a test.", prompt)

    def test_whole_prompt_requires_output_markers(self):
        self.assertIn("Preserve each input marker exactly", _WHOLE_TRANSLATE_SYSTEM_PROMPT)
        self.assertIn("[$12] translated text", _WHOLE_TRANSLATE_SYSTEM_PROMPT)

    def test_parse_numbered_format(self):
        response = """[$0] 你好世界。
[$1] 这是一个测试。"""
        result = _parse_whole_response(response, 2)
        self.assertEqual(result, ["你好世界。", "这是一个测试。"])

    def test_parse_plain_format(self):
        response = """你好世界。
这是一个测试。"""
        result = _parse_whole_response(response, 2)
        self.assertEqual(result, ["你好世界。", "这是一个测试。"])

    def test_parse_partial_match_fills_rest(self):
        response = "[$0] 只有第一句"
        result = _parse_whole_response(response, 3)
        self.assertEqual(result, ["只有第一句", "", ""])

    def test_parse_empty(self):
        result = _parse_whole_response("", 5)
        self.assertEqual(len(result), 5)
        self.assertTrue(all(t == "" for t in result))

    def test_translate_subtitles_whole_flag(self):
        """whole=True triggers _translate_whole path."""
        class FakeClient:
            def __init__(self, **kw): pass
            async def __aenter__(self): return self
            async def __aexit__(self, *args): pass

            async def post(self, url, **kw):
                class FakeResp:
                    status_code = 200
                    def json(self):
                        return {"choices": [{"message": {
                            "content": "[$0] 你好\n[$1] 世界"
                        }}]}
                return FakeResp()

        subs = [
            {"start": 0, "end": 500, "text": "Hello"},
            {"start": 600, "end": 1200, "text": "world"},
        ]

        with patch("youtube_ingest.translate.httpx.AsyncClient", new=FakeClient), \
             patch.dict(os.environ, {"OPENAI_API_KEY": "sk"}):
            result = asyncio.run(
                translate_subtitles(subs, "en", "zh-CN", provider="openai", whole=True)
            )
            self.assertEqual(len(result), 2)
            self.assertEqual(result[0]["translation"], "你好")
            self.assertEqual(result[1]["translation"], "世界")
            self.assertEqual(result[0]["text"], "Hello")

    def test_translate_subtitles_whole_false_still_batch(self):
        """whole=False (default) uses batch mode."""
        from youtube_ingest.translate import TRANSLATE_PROVIDERS

        @staticmethod
        async def fake(text, from_lang, to_lang, **kw):
            return f"TR[{text}]"

        TRANSLATE_PROVIDERS["_t_"] = fake
        try:
            subs = [
                {"start": 0, "end": 500, "text": "A"},
                {"start": 600, "end": 1200, "text": "B"},
            ]
            result = asyncio.run(
                translate_subtitles(subs, "en", "zh-CN", provider="_t_", whole=False)
            )
            self.assertEqual(result[0]["translation"], "TR[A]")
            self.assertEqual(result[1]["translation"], "TR[B]")
        finally:
            TRANSLATE_PROVIDERS.pop("_t_", None)

    def test_translate_subtitles_empty(self):
        result = asyncio.run(
            translate_subtitles([], "en", "zh-CN", provider="x", api_key="k", whole=True)
        )
        self.assertEqual(result, [])

    def test_parse_with_header_text(self):
        response = """Here are the translations:

你好世界。
这是一个测试。
谢谢。"""
        result = _parse_whole_response(response, 3)
        self.assertEqual(result, ["你好世界。", "这是一个测试。", "谢谢。"])

    def test_parse_more_lines_than_expected(self):
        response = """[$0] 零
[$1] 一
[$2] 二
[$3] 三"""
        result = _parse_whole_response(response, 2)
        self.assertEqual(len(result), 2)
        self.assertEqual(result[0], "零")
        self.assertEqual(result[1], "一")


if __name__ == "__main__":
    unittest.main()
