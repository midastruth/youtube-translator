import { TranslateError } from "./errors.js";
import { modelEndpoint } from "../../worker/model-endpoint.js";
import type { SubtitleCue } from "./types.js";

export { TranslateError };

export const OPENAI_TRANSLATE_SYSTEM_PROMPT =
  "You are a professional subtitle translator. " +
  "Translate the following subtitle text from {from_lang} to {to_lang}. " +
  "Return ONLY the translation, no explanations, no prefixes.";

export const WHOLE_TRANSLATE_SYSTEM_PROMPT = `\
You are a professional subtitle translator. Your task is to translate an entire
subtitle transcript line by line.

Rules:
1. Translate each line from {from_lang} to {to_lang}.
2. Keep translations natural and conversational — this is spoken language.
3. Maintain consistent terminology throughout (same word → same translation).
4. Preserve speaker markers: if a line starts with ">> ", keep ">> " in the output.
5. Keep each translated line roughly the same length as the original (subtitle constraint).
6. Return exactly one translated line for every input line, in the SAME order.
7. Preserve each input marker exactly: input "[$12] text" must become
   "[$12] translated text".
8. Do NOT add headers, explanations, code fences, or any extra text.`;

export interface TranslateOptions {
  signal?: AbortSignal;
  provider?: string;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  concurrency?: number;
  timeout?: number;
  whole?: boolean;
  wholeFallbackToBatch?: boolean;
  fallbackToBatch?: boolean;
  chunkSize?: number;
}

export type TranslatorFunction = (
  text: string,
  fromLang: string,
  toLang: string,
  options?: TranslateOptions
) => Promise<string>;

async function openaiTranslate(
  text: string,
  fromLang: string,
  toLang: string,
  options?: TranslateOptions
): Promise<string> {
  const apiKey = options?.apiKey || process.env.OPENAI_API_KEY || process.env.TRANSLATE_API_KEY;
  const baseUrl = modelEndpoint(options?.baseUrl);

  if (!apiKey) {
    throw new TranslateError("OPENAI_API_KEY or TRANSLATE_API_KEY is required");
  }

  const systemPrompt = OPENAI_TRANSLATE_SYSTEM_PROMPT
    .replace("{from_lang}", fromLang)
    .replace("{to_lang}", toLang);
  const model = options?.model || "gpt-3.5-turbo";
  const timeout = options?.timeout ?? 30.0;

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error("Request timed out")),
    timeout * 1000
  );
  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: text },
        ],
        temperature: 0.1,
        max_tokens: 1024,
      }),
      redirect: "error",
      signal: options?.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal,
    });

    if (!res.ok) throw new TranslateError(`OpenAI API returned ${res.status}`);

    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    return String(content || "").trim();
  } catch (err: any) {
    // Provider boundary: cancellation/invalid JSON propagate; network failures
    // receive provider context. Timeout uses controller state, not message text.
    options?.signal?.throwIfAborted();
    if (err instanceof SyntaxError) throw err;
    if (controller.signal.aborted) {
      throw new TranslateError(`OpenAI API request timed out after ${timeout}s`);
    }
    if (err instanceof TranslateError) throw err;
    throw new TranslateError(`OpenAI API request failed: ${err?.message || err}`);
  } finally {
    clearTimeout(timer);
  }
}

const DEEPL_LANG_MAP: Record<string, string> = {
  "zh-CN": "ZH",
  zh: "ZH",
  "zh-Hans": "ZH",
  "zh-Hant": "ZH",
  en: "EN",
  ja: "JA",
  ko: "KO",
  fr: "FR",
  de: "DE",
  es: "ES",
  pt: "PT",
  ru: "RU",
};

async function deeplTranslate(
  text: string,
  fromLang: string,
  toLang: string,
  options?: TranslateOptions
): Promise<string> {
  const apiKey = options?.apiKey || process.env.DEEPL_API_KEY;
  if (!apiKey) {
    throw new TranslateError("DEEPL_API_KEY is required");
  }

  const baseUrl = modelEndpoint(options?.baseUrl, "deepl");
  const sourceLang = DEEPL_LANG_MAP[fromLang] || fromLang.toUpperCase().slice(0, 2);
  const targetLang = DEEPL_LANG_MAP[toLang] || toLang.toUpperCase().slice(0, 2);
  const timeout = options?.timeout ?? 15.0;

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error("Request timed out")),
    timeout * 1000
  );
  try {
    const res = await fetch(`${baseUrl}/translate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `DeepL-Auth-Key ${apiKey}`,
      },
      body: JSON.stringify({
        text: [text],
        source_lang: sourceLang,
        target_lang: targetLang,
      }),
      redirect: "error",
      signal: options?.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal,
    });

    if (!res.ok) {
      const errorText = (await res.text()).slice(0, 200);
      throw new TranslateError(`DeepL API returned ${res.status}: ${errorText}`);
    }

    const data = await res.json();
    return String(data?.translations?.[0]?.text || "").trim();
  } catch (err: any) {
    // Provider boundary, with the same cancellation/decoding rules as OpenAI.
    options?.signal?.throwIfAborted();
    if (err instanceof SyntaxError) throw err;
    if (controller.signal.aborted) {
      throw new TranslateError(`DeepL API request timed out after ${timeout}s`);
    }
    if (err instanceof TranslateError) throw err;
    throw new TranslateError(`DeepL API request failed: ${err?.message || err}`);
  } finally {
    clearTimeout(timer);
  }
}

export const TRANSLATE_PROVIDERS: Record<string, TranslatorFunction> = {
  openai: openaiTranslate,
  deepl: deeplTranslate,
};

export async function translateSingle(
  text: string,
  fromLang: string,
  toLang: string,
  options?: TranslateOptions
): Promise<string> {
  options?.signal?.throwIfAborted();
  const provider = options?.provider || "openai";
  const translator = TRANSLATE_PROVIDERS[provider];
  if (!translator) {
    throw new TranslateError(`Unknown translation provider: ${provider}`);
  }
  return translator(text, fromLang, toLang, options);
}

async function asyncPool<T, R>(
  limit: number,
  items: T[],
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const safeLimit =
    typeof limit === "number" && Number.isFinite(limit) && limit > 0
      ? Math.floor(limit)
      : 1;
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  const workers = Array.from({ length: Math.min(safeLimit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex++;
      results[currentIndex] = await fn(items[currentIndex], currentIndex);
    }
  });

  await Promise.all(workers);
  return results;
}

export async function translateBatch(
  texts: string[],
  fromLang: string,
  toLang: string,
  options?: TranslateOptions
): Promise<string[]> {
  if (texts.length === 0) {
    return [];
  }
  const rawConcurrency = options?.concurrency;
  const concurrency =
    typeof rawConcurrency === "number" && Number.isFinite(rawConcurrency) && rawConcurrency > 0
      ? Math.floor(rawConcurrency)
      : 3;
  return asyncPool(concurrency, texts, async (text) => {
    try {
      return await translateSingle(text, fromLang, toLang, options);
    } catch (error) {
      // Per-cue provider boundary: only known provider failures become failed
      // cues. Cancellation, decoding and configuration failures propagate.
      options?.signal?.throwIfAborted();
      if (!(error instanceof TranslateError)) throw error;
      return "[Translation failed]";
    }
  });
}

export async function* translateStream(
  text: string,
  fromLang: string,
  toLang: string,
  options?: TranslateOptions
): AsyncGenerator<string, void, unknown> {
  const provider = options?.provider || "openai";
  if (provider !== "openai") {
    const result = await translateSingle(text, fromLang, toLang, options);
    yield result;
    return;
  }

  const apiKey = options?.apiKey || process.env.OPENAI_API_KEY || process.env.TRANSLATE_API_KEY;
  const baseUrl = modelEndpoint(options?.baseUrl);

  if (!apiKey) {
    throw new TranslateError("OPENAI_API_KEY or TRANSLATE_API_KEY is required");
  }

  const systemPrompt = OPENAI_TRANSLATE_SYSTEM_PROMPT
    .replace("{from_lang}", fromLang)
    .replace("{to_lang}", toLang);
  const model = options?.model || "gpt-3.5-turbo";
  const timeout = options?.timeout ?? 60.0;

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error("Stream timed out")),
    timeout * 1000
  );
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: text },
        ],
        temperature: 0.1,
        max_tokens: 1024,
        stream: true,
      }),
      redirect: "error",
      signal: options?.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal,
    });

    if (!res.ok) {
      const errorBody = (await res.text()).slice(0, 200);
      throw new TranslateError(`OpenAI streaming API returned ${res.status}: ${errorBody}`);
    }

    if (!res.body) {
      return;
    }

    reader = res.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) { buffer += decoder.decode(); break; }
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data: ")) continue;
        const dataStr = trimmed.slice(6).trim();
        if (dataStr === "[DONE]") return;
        const data = JSON.parse(dataStr);
        const content = data?.choices?.[0]?.delta?.content;
        if (content) yield content;
      }
    }

    if (buffer.trim()) {
      const trimmed = buffer.trim();
      if (trimmed.startsWith("data: ")) {
        const dataStr = trimmed.slice(6).trim();
        if (dataStr !== "[DONE]") {
          const data = JSON.parse(dataStr);
          const content = data?.choices?.[0]?.delta?.content;
          if (content) yield content;
        }
      }
    }
  } catch (err: any) {
    // Streaming provider boundary: malformed frames must not be skipped.
    options?.signal?.throwIfAborted();
    if (err instanceof SyntaxError) throw err;
    if (controller.signal.aborted) {
      throw new TranslateError(`OpenAI streaming API timed out after ${timeout}s`);
    }
    if (err instanceof TranslateError) throw err;
    throw new TranslateError(`OpenAI streaming API error: ${err?.message || err}`);
  } finally {
    clearTimeout(timer);
    // Abort also releases the fetch when a consumer returns early. Cancelling
    // an already-errored reader would reject and mask the provider error above.
    controller.abort();
    reader?.releaseLock();
  }
}

export function buildWholePrompt(subtitles: Array<{ text: string }>): string {
  return subtitles.map((sub, i) => `[$${i}] ${sub.text}`).join("\n");
}

export function parseWholeResponse(responseText: string, count: number): string[] {
  if (count <= 0) return [];
  const rawLines = responseText.trim().split("\n");

  const markerRegex = /^\[\$?(\d+)\]\s*[\.:]?\s*/;
  const translations = new Map<number, string>();
  let hasAnyMarker = false;

  for (const line of rawLines) {
    const stripped = line.trim();
    if (!stripped) continue;

    const match = stripped.match(markerRegex);
    if (match) {
      hasAnyMarker = true;
      const idx = parseInt(match[1], 10);
      if (idx < count) {
        const text = stripped.slice(match[0].length).trim();
        if (!translations.has(idx) || (!translations.get(idx) && text)) {
          translations.set(idx, text);
        }
      }
    }
  }

  // Strategy 1: If ANY marker was found in the output, strictly preserve index mapping!
  // Missing indices remain empty strings so they can be filled individually.
  if (hasAnyMarker) {
    return Array.from({ length: count }, (_, i) => translations.get(i) ?? "");
  }

  // Strategy 2: If NO markers at all were detected, match by count if cleaned lines >= count.
  const nonEmpty = rawLines.map((l) => l.trim()).filter(Boolean);
  const cleaned = nonEmpty.filter(
    (l) => !/^(Here\b|Below\b|Translation\b|---|===)/i.test(l)
  );

  if (cleaned.length >= count) {
    return cleaned.slice(0, count);
  }

  // Strategy 3: partial match — fill what we have, leave rest empty.
  return Array.from({ length: count }, (_, i) => translations.get(i) ?? "");
}

export async function translateWhole(
  cues: SubtitleCue[],
  fromLang: string,
  toLang: string,
  options?: TranslateOptions
): Promise<SubtitleCue[]> {
  if (cues.length === 0) return [];

  const provider = options?.provider || "openai";
  if (provider !== "openai") {
    const texts = cues.map((c) => c.text);
    const translations = await translateBatch(texts, fromLang, toLang, options);
    return cues.map((cue, idx) => ({ ...cue, translation: translations[idx] }));
  }

  const apiKey = options?.apiKey || process.env.OPENAI_API_KEY || process.env.TRANSLATE_API_KEY;
  const baseUrl = modelEndpoint(options?.baseUrl);
  if (!apiKey) {
    throw new TranslateError("OPENAI_API_KEY or TRANSLATE_API_KEY is required");
  }

  const rawChunkSize = options?.chunkSize;
  const chunkSize =
    typeof rawChunkSize === "number" && Number.isFinite(rawChunkSize) && rawChunkSize > 0
      ? Math.floor(rawChunkSize)
      : 12;
  const fallbackToBatch = options?.fallbackToBatch ?? options?.wholeFallbackToBatch ?? true;
  const timeout = options?.timeout ?? 120.0;
  const model = options?.model || "gpt-3.5-turbo";

  const chunks: SubtitleCue[][] = [];
  for (let i = 0; i < cues.length; i += chunkSize) {
    chunks.push(cues.slice(i, i + chunkSize));
  }

  const result: SubtitleCue[] = [];

  for (const chunk of chunks) {
    options?.signal?.throwIfAborted();
    const systemPrompt = WHOLE_TRANSLATE_SYSTEM_PROMPT
      .replace("{from_lang}", fromLang)
      .replace("{to_lang}", toLang);
    const userPrompt = buildWholePrompt(chunk);
    const estTokens = userPrompt.length * 1.0;
    const maxTokens = Math.min(16384, Math.max(2048, Math.floor(estTokens * 2.5)));

    let fullResponse = "";
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error("Whole-transcript request timed out")),
      timeout * 1000
    );
    try {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
          temperature: 0.1,
          max_tokens: maxTokens,
        }),
        redirect: "error",
        signal: options?.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal,
      });

      if (!res.ok) throw new TranslateError(`OpenAI API (${res.status})`);

      const data = await res.json();
      fullResponse = data?.choices?.[0]?.message?.content?.trim() || "";
    } catch (err: any) {
      // Whole-provider boundary: preserve cancellation and decoding failures.
      options?.signal?.throwIfAborted();
      if (err instanceof SyntaxError) throw err;
      if (controller.signal.aborted) {
        throw new TranslateError(`OpenAI API request timed out after ${timeout}s`);
      }
      if (err instanceof TranslateError) throw err;
      throw new TranslateError(`OpenAI translation request failed: ${err?.message || err}`);
    } finally {
      clearTimeout(timer);
    }

    const translations = parseWholeResponse(fullResponse, chunk.length);
    const validCount = translations.filter((t) => Boolean(t && t.trim())).length;

    if (validCount < chunk.length * 0.5) {
      if (!fallbackToBatch) {
        throw new TranslateError(
          `Whole-transcript response contained only ${validCount}/${chunk.length} parseable translations`
        );
      }
      const batchTexts = chunk.map((c) => c.text);
      const batchTranslations = await translateBatch(batchTexts, fromLang, toLang, options);
      for (let i = 0; i < chunk.length; i++) {
        result.push({ ...chunk[i], translation: batchTranslations[i] });
      }
      continue;
    }

    for (let i = 0; i < chunk.length; i++) {
      let tr = translations[i]?.trim();
      if (!tr) {
        try {
          tr = await translateSingle(chunk[i].text, fromLang, toLang, options);
        } catch (error) {
          // Same per-cue provider boundary as translateBatch.
          options?.signal?.throwIfAborted();
          if (!(error instanceof TranslateError)) throw error;
          tr = "[Translation failed]";
        }
      }
      result.push({ ...chunk[i], translation: tr || "[Translation failed]" });
    }
  }

  return result;
}

export async function translateSubtitles(
  subtitles: SubtitleCue[],
  fromLang: string,
  toLang: string,
  options?: TranslateOptions
): Promise<SubtitleCue[]> {
  if (subtitles.length === 0) return [];

  if (options?.whole) {
    return translateWhole(subtitles, fromLang, toLang, options);
  }

  const texts = subtitles.map((s) => s.text);
  const translations = await translateBatch(texts, fromLang, toLang, options);
  return subtitles.map((sub, idx) => ({
    ...sub,
    translation: translations[idx],
  }));
}

// Snake_case aliases for compatibility
export const translate_single = translateSingle;
export const translate_batch = translateBatch;
export const translate_stream = translateStream;
export const translate_whole = translateWhole;
export const translate_subtitles = translateSubtitles;
export const _build_whole_prompt = buildWholePrompt;
export const _parse_whole_response = parseWholeResponse;
export const _WHOLE_TRANSLATE_SYSTEM_PROMPT = WHOLE_TRANSLATE_SYSTEM_PROMPT;
