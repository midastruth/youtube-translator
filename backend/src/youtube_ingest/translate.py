"""Translation client — calls external translation APIs for subtitle translation.

Supports OpenAI-compatible and DeepL APIs. Designed to be called from the
backend service, but can also be used standalone.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import time
from dataclasses import dataclass, field

import httpx

logger = logging.getLogger(__name__)


class TranslateError(RuntimeError):
    """A user-facing translation error."""


@dataclass
class TranslateResult:
    text: str
    translation: str = ""


# ── OpenAI-compatible translate ────────────────────────────────────────

_OPENAI_TRANSLATE_SYSTEM_PROMPT = (
    "You are a professional subtitle translator. "
    "Translate the following subtitle text from {from_lang} to {to_lang}. "
    "Return ONLY the translation, no explanations, no prefixes."
)


async def _openai_translate(
    text: str,
    from_lang: str,
    to_lang: str,
    *,
    api_key: str | None = None,
    base_url: str | None = None,
    model: str = "gpt-3.5-turbo",
    timeout: float = 30.0,
) -> str:
    api_key = api_key or os.getenv("OPENAI_API_KEY") or os.getenv("TRANSLATE_API_KEY")
    base_url = (base_url or os.getenv("OPENAI_BASE_URL") or "https://api.openai.com/v1").rstrip("/")

    if not api_key:
        raise TranslateError("OPENAI_API_KEY or TRANSLATE_API_KEY is required")

    system_prompt = _OPENAI_TRANSLATE_SYSTEM_PROMPT.format(
        from_lang=from_lang, to_lang=to_lang
    )

    async with httpx.AsyncClient(timeout=timeout) as client:
        resp = await client.post(
            f"{base_url}/chat/completions",
            headers={"Authorization": f"Bearer {api_key}"},
            json={
                "model": model,
                "messages": [
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": text},
                ],
                "temperature": 0.1,
                "max_tokens": 1024,
            },
        )
        if resp.status_code >= 400:
            raise TranslateError(
                f"OpenAI API returned {resp.status_code}: "
                + (resp.json().get("error", {}).get("message", resp.text) if resp.content else "")
            )
        data = resp.json()
        return data["choices"][0]["message"]["content"].strip()


# ── DeepL translate ────────────────────────────────────────────────────

async def _deepl_translate(
    text: str,
    from_lang: str,
    to_lang: str,
    *,
    api_key: str | None = None,
    timeout: float = 15.0,
) -> str:
    api_key = api_key or os.getenv("DEEPL_API_KEY")
    if not api_key:
        raise TranslateError("DEEPL_API_KEY is required")

    # Map language codes to DeepL format
    lang_map: dict[str, str] = {
        "zh-CN": "ZH",
        "zh": "ZH",
        "zh-Hans": "ZH",
        "zh-Hant": "ZH",
        "en": "EN",
        "ja": "JA",
        "ko": "KO",
        "fr": "FR",
        "de": "DE",
        "es": "ES",
        "pt": "PT",
        "ru": "RU",
    }

    source_lang = lang_map.get(from_lang, from_lang.upper()[:2])
    target_lang = lang_map.get(to_lang, to_lang.upper()[:2])

    async with httpx.AsyncClient(timeout=timeout) as client:
        resp = await client.post(
            "https://api-free.deepl.com/v2/translate",
            headers={"Authorization": f"DeepL-Auth-Key {api_key}"},
            json={
                "text": [text],
                "source_lang": source_lang,
                "target_lang": target_lang,
            },
        )
        if resp.status_code >= 400:
            raise TranslateError(
                f"DeepL API returned {resp.status_code}: {resp.text[:200]}"
            )
        data = resp.json()
        return data["translations"][0]["text"].strip()


# ── unified api ────────────────────────────────────────────────────────

TRANSLATE_PROVIDERS = {
    "openai": _openai_translate,
    "deepl": _deepl_translate,
}


async def translate_single(
    text: str,
    from_lang: str,
    to_lang: str,
    *,
    provider: str = "openai",
    api_key: str | None = None,
    base_url: str | None = None,
    model: str | None = None,
    timeout: float = 30.0,
) -> str:
    """Translate a single text string. Raises TranslateError on failure."""
    translator = TRANSLATE_PROVIDERS.get(provider)
    if translator is None:
        raise TranslateError(f"Unknown translation provider: {provider}")

    kwargs: dict = {"timeout": timeout}
    if api_key:
        kwargs["api_key"] = api_key
    if base_url:
        kwargs["base_url"] = base_url
    if model and provider == "openai":
        kwargs["model"] = model

    return await translator(text, from_lang, to_lang, **kwargs)


async def translate_batch(
    texts: list[str],
    from_lang: str,
    to_lang: str,
    *,
    provider: str = "openai",
    api_key: str | None = None,
    base_url: str | None = None,
    model: str | None = None,
    concurrency: int = 3,
    timeout: float = 30.0,
) -> list[str]:
    """Translate a batch of texts with limited concurrency."""
    import asyncio

    sem = asyncio.Semaphore(concurrency)

    async def _one(text: str) -> str:
        async with sem:
            try:
                return await translate_single(
                    text, from_lang, to_lang,
                    provider=provider, api_key=api_key,
                    base_url=base_url, model=model, timeout=timeout,
                )
            except (TranslateError, Exception):
                return "[Translation failed]"

    return await asyncio.gather(*(_one(t) for t in texts))


async def translate_stream(
    text: str,
    from_lang: str,
    to_lang: str,
    *,
    provider: str = "openai",
    api_key: str | None = None,
    base_url: str | None = None,
    model: str = "gpt-3.5-turbo",
    timeout: float = 60.0,
):
    """Translate with streaming — yields partial translation chunks.

    Usage:
        async for chunk in translate_stream("Hello", "en", "zh-CN"):
            print(chunk, end="", flush=True)
    """
    if provider != "openai":
        # Fallback: just yield the entire result at once
        result = await translate_single(
            text, from_lang, to_lang,
            provider=provider, api_key=api_key,
            base_url=base_url, model=model, timeout=timeout,
        )
        yield result
        return

    api_key = api_key or os.getenv("OPENAI_API_KEY") or os.getenv("TRANSLATE_API_KEY")
    base_url = (base_url or os.getenv("OPENAI_BASE_URL") or "https://api.openai.com/v1").rstrip("/")

    if not api_key:
        raise TranslateError("OPENAI_API_KEY or TRANSLATE_API_KEY is required")

    system_prompt = _OPENAI_TRANSLATE_SYSTEM_PROMPT.format(
        from_lang=from_lang, to_lang=to_lang
    )

    async with httpx.AsyncClient(timeout=timeout) as client:
        async with client.stream(
            "POST",
            f"{base_url}/chat/completions",
            headers={"Authorization": f"Bearer {api_key}"},
            json={
                "model": model,
                "messages": [
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": text},
                ],
                "temperature": 0.1,
                "max_tokens": 1024,
                "stream": True,
            },
        ) as resp:
            if resp.status_code >= 400:
                error_body = await resp.aread()
                raise TranslateError(
                    f"OpenAI streaming API returned {resp.status_code}: {error_body[:200]}"
                )
            async for line in resp.aiter_lines():
                if line.startswith("data: "):
                    data_str = line[6:].strip()
                    if data_str == "[DONE]":
                        return
                    try:
                        data = json.loads(data_str)
                        choice = data["choices"][0]
                        delta = choice.get("delta", {})
                        content = delta.get("content", "")
                        if content:
                            yield content
                    except (json.JSONDecodeError, KeyError, IndexError):
                        continue


async def translate_subtitles(
    subtitles: list[dict],
    from_lang: str,
    to_lang: str,
    *,
    provider: str = "openai",
    api_key: str | None = None,
    base_url: str | None = None,
    model: str | None = None,
    concurrency: int = 3,
    timeout: float = 30.0,
    whole: bool = False,
) -> list[dict]:
    """Translate a list of subtitle cues.

    If whole=True: sends the entire transcript at once, gets all translations
    back in one API call. The model sees full context → consistent terminology,
    proper pronoun resolution, natural flow.

    If whole=False (default): translates each cue independently in parallel.
    """
    if not whole:
        texts = [s["text"] for s in subtitles]
        translations = await translate_batch(
            texts, from_lang, to_lang,
            provider=provider, api_key=api_key,
            base_url=base_url, model=model,
            concurrency=concurrency, timeout=timeout,
        )
        return [{**sub, "translation": tr} for sub, tr in zip(subtitles, translations)]

    if not subtitles:
        return []

    return await _translate_whole(subtitles, from_lang, to_lang,
                                  provider=provider, api_key=api_key,
                                  base_url=base_url, model=model,
                                  timeout=timeout)


# ── whole-transcript translation ───────────────────────────────────────

_WHOLE_TRANSLATE_SYSTEM_PROMPT = """\
You are a professional subtitle translator. Your task is to translate an entire
subtitle transcript line by line.

Rules:
1. Translate each line from {from_lang} to {to_lang}.
2. Keep translations natural and conversational — this is spoken language.
3. Maintain consistent terminology throughout (same word → same translation).
4. Preserve speaker markers: if a line starts with ">> ", keep ">> " in the output.
5. Keep each translated line roughly the same length as the original (subtitle constraint).
6. Return ONLY the translations, one per line, in the SAME order.
7. Each output line MUST correspond to exactly one input line.
8. Do NOT add numbering, prefixes, quotes, or any extra text."""


def _build_whole_prompt(subtitles: list[dict]) -> str:
    """Build the user prompt: numbered lines for the model to translate."""
    lines = []
    for i, sub in enumerate(subtitles):
        lines.append(f"[${i}] {sub['text']}")
    return "\n".join(lines)


def _parse_whole_response(response_text: str, count: int) -> list[str]:
    """Parse the model's line-by-line translation back into individual strings.

    Handles multiple common formats the model might produce:
    - [N] translated text
    - plain lines (one per input)
    - numbered lines like "1. translation"
    """
    raw_lines = response_text.strip().split("\n")

    # Strategy 1: try [N] prefix matching
    translations: dict[int, str] = {}
    for line in raw_lines:
        stripped = line.strip()
        if not stripped:
            continue
        m = re.match(r"^\[?\$?(\d+)\]?\s*[\.:]?\s*", stripped)
        if m:
            idx = int(m.group(1))
            if idx < count:
                translations[idx] = stripped[m.end():].strip()

    if len(translations) >= count:
        return [translations.get(i, "") for i in range(count)]

    # Strategy 2: filter out empty/header lines, match by count
    non_empty = [l.strip() for l in raw_lines if l.strip()]
    # Remove common header lines
    cleaned = [l for l in non_empty
               if not l.startswith(("Here", "Below", "Translation", "---", "==="))]

    if len(cleaned) >= count:
        return cleaned[:count]

    # Strategy 3: partial match — fill what we have, leave rest empty
    result: list[str] = []
    for i in range(count):
        result.append(translations.get(i, ""))
    return result


async def _translate_whole(
    subtitles: list[dict],
    from_lang: str,
    to_lang: str,
    *,
    provider: str = "openai",
    api_key: str | None = None,
    base_url: str | None = None,
    model: str | None = None,
    timeout: float = 120.0,
) -> list[dict]:
    """Translate all subtitles in a single API call.

    The model receives the entire transcript with numbered lines and returns
    one translation per line. This gives the model full context for consistent
    terminology and natural flow.
    """

    if provider != "openai":
        texts = [s["text"] for s in subtitles]
        translations = await translate_batch(
            texts, from_lang, to_lang,
            provider=provider, api_key=api_key,
            base_url=base_url, model=model,
            timeout=timeout,
        )
        return [{**sub, "translation": tr} for sub, tr in zip(subtitles, translations)]

    api_key = api_key or os.getenv("OPENAI_API_KEY") or os.getenv("TRANSLATE_API_KEY")
    base_url = (base_url or os.getenv("OPENAI_BASE_URL") or "https://api.openai.com/v1").rstrip("/")

    if not api_key:
        raise TranslateError("OPENAI_API_KEY or TRANSLATE_API_KEY is required")

    system_prompt = _WHOLE_TRANSLATE_SYSTEM_PROMPT.format(
        from_lang=from_lang, to_lang=to_lang
    )
    user_prompt = _build_whole_prompt(subtitles)

    # Estimate tokens: ~1.3 tokens per char for CJK, ~0.75 for Latin
    est_tokens = len(user_prompt) * 1.0
    max_tokens = min(16384, max(2048, int(est_tokens * 2.5)))

    logger.info(
        "Whole-transcript translate: %d cues, ~%d chars → max_tokens=%d",
        len(subtitles), len(user_prompt), max_tokens,
    )

    async with httpx.AsyncClient(timeout=timeout) as client:
        resp = await client.post(
            f"{base_url}/chat/completions",
            headers={"Authorization": f"Bearer {api_key}"},
            json={
                "model": model or "gpt-3.5-turbo",
                "messages": [
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt},
                ],
                "temperature": 0.1,
                "max_tokens": max_tokens,
            },
        )
        if resp.status_code >= 400:
            error_msg = ""
            try:
                error_msg = resp.json().get("error", {}).get("message", "")
            except Exception:
                error_msg = resp.text[:200]
            raise TranslateError(f"OpenAI API ({resp.status_code}): {error_msg}")

        data = resp.json()
        full_response = data["choices"][0]["message"]["content"].strip()

    # Parse line-by-line translations
    translations = _parse_whole_response(full_response, len(subtitles))

    # Fallback: if parsing failed badly, retry with batch mode
    valid_count = sum(1 for t in translations if t)
    if valid_count < len(subtitles) * 0.5:
        logger.warning(
            "Whole-transcript parse only got %d/%d translations, falling back to batch",
            valid_count, len(subtitles),
        )
        texts = [s["text"] for s in subtitles]
        batch_translations = await translate_batch(
            texts, from_lang, to_lang,
            provider=provider, api_key=api_key,
            base_url=base_url, model=model,
            timeout=timeout,
        )
        return [{**sub, "translation": tr} for sub, tr in zip(subtitles, batch_translations)]

    result: list[dict] = []
    for sub, tr in zip(subtitles, translations):
        result.append({**sub, "translation": tr or "[Translation failed]"})
    return result
