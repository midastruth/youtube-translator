import assert from "node:assert/strict";
import { trustModelEndpoint } from "./support/model-endpoint.js";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  TranslateError,
  TRANSLATE_PROVIDERS,
  translateSingle,
  translateBatch,
  translateStream,
  translateSubtitles,
  translateWhole,
  buildWholePrompt,
  parseWholeResponse,
  WHOLE_TRANSLATE_SYSTEM_PROMPT,
} from "../server/src/translate.js";
import { fallbackSegments, WhisperClient, transcribeTimedChunks } from "../server/src/transcribe.js";
import { splitAudio } from "../server/src/audio.js";
import { IngestError } from "../server/src/errors.js";
import type { SubtitleCue } from "../server/src/types.js";

describe("Translate Module", () => {
  it("test_unknown_provider", async () => {
    await assert.rejects(
      async () => {
        await translateSingle("Hello", "en", "zh-CN", { provider: "nonexistent" });
      },
      (err: any) => {
        assert.ok(err instanceof TranslateError);
        assert.ok(err.message.includes("Unknown translation provider"));
        return true;
      }
    );
  });

  it("test_translate_error_is_error", () => {
    const err = new TranslateError("test message");
    assert.ok(err instanceof Error);
    assert.equal(err.name, "TranslateError");
    assert.equal(err.message, "test message");
  });

  it("test_no_api_key_raises_for_openai", async () => {
    const prevKey = process.env.OPENAI_API_KEY;
    const prevTrKey = process.env.TRANSLATE_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.TRANSLATE_API_KEY;
    try {
      await assert.rejects(
        async () => {
          await translateSingle("Hello", "en", "zh-CN", { provider: "openai" });
        },
        (err: any) => {
          assert.ok(err instanceof TranslateError);
          assert.ok(err.message.includes("TRANSLATE_API_KEY"));
          return true;
        }
      );
    } finally {
      if (prevKey) process.env.OPENAI_API_KEY = prevKey;
      if (prevTrKey) process.env.TRANSLATE_API_KEY = prevTrKey;
    }
  });

  it("test_batch_success", async () => {
    TRANSLATE_PROVIDERS["_t_"] = async (text) => `TR[${text}]`;
    try {
      const res = await translateBatch(["x", "y"], "en", "zh-CN", { provider: "_t_" });
      assert.deepEqual(res, ["TR[x]", "TR[y]"]);
    } finally {
      delete TRANSLATE_PROVIDERS["_t_"];
    }
  });

  it("test_batch_partial_failure", async () => {
    TRANSLATE_PROVIDERS["_t_"] = async (text) => {
      if (text === "a") {
        throw new TranslateError("fail-a");
      }
      return `TR[${text}]`;
    };
    try {
      const res = await translateBatch(["a", "b", "a", "c"], "en", "zh-CN", { provider: "_t_" });
      assert.deepEqual(res, [
        "[Translation failed]",
        "TR[b]",
        "[Translation failed]",
        "TR[c]",
      ]);
    } finally {
      delete TRANSLATE_PROVIDERS["_t_"];
    }
  });

  it("test_batch_empty", async () => {
    TRANSLATE_PROVIDERS["_t_"] = async (text) => `TR[${text}]`;
    try {
      const res = await translateBatch([], "en", "zh-CN", { provider: "_t_" });
      assert.deepEqual(res, []);
    } finally {
      delete TRANSLATE_PROVIDERS["_t_"];
    }
  });

  it("test_batch_concurrency_edge_cases", async () => {
    TRANSLATE_PROVIDERS["_t_"] = async (text) => `TR[${text}]`;
    try {
      // Concurrency 0, NaN, negative should safely default to >= 1 and translate all items
      for (const concurrency of [0, NaN, -1]) {
        const res = await translateBatch(["a", "b"], "en", "zh-CN", {
          provider: "_t_",
          concurrency,
        });
        assert.deepEqual(res, ["TR[a]", "TR[b]"]);
      }
    } finally {
      delete TRANSLATE_PROVIDERS["_t_"];
    }
  });

  it("test_translate_subtitles", async () => {
    TRANSLATE_PROVIDERS["_t_"] = async (text) => `TR[${text}]`;
    try {
      const subs: SubtitleCue[] = [
        { start: 0, end: 0.5, text: "Hello", translation: "" },
        { start: 0.6, end: 1.2, text: "world", translation: "" },
      ];
      const res = await translateSubtitles(subs, "en", "zh-CN", { provider: "_t_" });
      assert.equal(res[0].translation, "TR[Hello]");
      assert.equal(res[1].translation, "TR[world]");
      assert.equal(res[0].start, 0);
      assert.equal(res[1].end, 1.2);
    } finally {
      delete TRANSLATE_PROVIDERS["_t_"];
    }
  });

  it("test_stream_non_openai_falls_back", async () => {
    TRANSLATE_PROVIDERS["_t_"] = async () => "Hallo";
    try {
      const chunks: string[] = [];
      for await (const chunk of translateStream("Hello", "en", "de", { provider: "_t_" })) {
        chunks.push(chunk);
      }
      assert.deepEqual(chunks, ["Hallo"]);
    } finally {
      delete TRANSLATE_PROVIDERS["_t_"];
    }
  });

  it("test_stream_yields_chunks", async () => {
    const originalFetch = globalThis.fetch;
    const sseData =
      'data: {"choices":[{"delta":{"content":"a"}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":"b"}}]}\n\n' +
      "data: [DONE]\n\n";

    globalThis.fetch = async () => {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(sseData));
          controller.close();
        },
      });
      return new Response(stream, { status: 200 });
    };

    try {
      const chunks: string[] = [];
      for await (const chunk of translateStream("H", "en", "zh-CN", {
        provider: "openai",
        apiKey: "sk",
      })) {
        chunks.push(chunk);
      }
      assert.deepEqual(chunks, ["a", "b"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("test_stream_error", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response("Unauthorized", { status: 401 });

    try {
      await assert.rejects(
        async () => {
          for await (const _ of translateStream("H", "en", "zh-CN", {
            provider: "openai",
            apiKey: "sk",
          })) {
            // consume
          }
        },
        (err: any) => {
          assert.ok(err instanceof TranslateError);
          assert.ok(err.message.includes("401"));
          return true;
        }
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("test_build_whole_prompt", () => {
    const subs: SubtitleCue[] = [
      { start: 0, end: 0.5, text: "Hello world." },
      { start: 0.6, end: 1.2, text: "This is a test." },
    ];
    const prompt = buildWholePrompt(subs);
    assert.ok(prompt.includes("[$0] Hello world."));
    assert.ok(prompt.includes("[$1] This is a test."));
  });

  it("test_whole_prompt_requires_output_markers", () => {
    assert.ok(WHOLE_TRANSLATE_SYSTEM_PROMPT.includes("Preserve each input marker exactly"));
    assert.ok(WHOLE_TRANSLATE_SYSTEM_PROMPT.includes("[$12] translated text"));
  });

  it("test_parse_numbered_format", () => {
    const response = "[$0] 你好世界。\n[$1] 这是一个测试。";
    const result = parseWholeResponse(response, 2);
    assert.deepEqual(result, ["你好世界。", "这是一个测试。"]);
  });

  it("test_parse_plain_format", () => {
    const response = "你好世界。\n这是一个测试。";
    const result = parseWholeResponse(response, 2);
    assert.deepEqual(result, ["你好世界。", "这是一个测试。"]);
  });

  it("test_parse_partial_match_fills_rest", () => {
    const response = "[$0] 只有第一句";
    const result = parseWholeResponse(response, 3);
    assert.deepEqual(result, ["只有第一句", "", ""]);
  });

  it("test_parse_empty", () => {
    const result = parseWholeResponse("", 5);
    assert.equal(result.length, 5);
    assert.ok(result.every((t) => t === ""));
  });

  it("test_parse_with_header_text", () => {
    const response = "Here are the translations:\n\n你好世界。\n这是一个测试。\n谢谢。";
    const result = parseWholeResponse(response, 3);
    assert.deepEqual(result, ["你好世界。", "这是一个测试。", "谢谢。"]);
  });

  it("test_parse_more_lines_than_expected", () => {
    const response = "[$0] 零\n[$1] 一\n[$2] 二\n[$3] 三";
    const result = parseWholeResponse(response, 2);
    assert.deepEqual(result, ["零", "一"]);
  });

  it("test_parse_out_of_order_markers", () => {
    const response = "[$1] 第二行\n[$0] 第一行";
    const result = parseWholeResponse(response, 2);
    assert.deepEqual(result, ["第一行", "第二行"]);
  });

  it("test_parse_missing_markers_retains_index_without_shifting", () => {
    const response = "[$0] 第一行\n[$2] 第三行";
    const result = parseWholeResponse(response, 3);
    assert.deepEqual(result, ["第一行", "", "第三行"]);
  });

  it("test_parse_duplicate_markers", () => {
    const response = "[$0] 第一次出现\n[$0] 重复出现\n[$1] 第二行";
    const result = parseWholeResponse(response, 2);
    assert.deepEqual(result, ["第一次出现", "第二行"]);
  });

  it("test_parse_digital_content_not_treated_as_marker", () => {
    // With marker: text starting with number is preserved
    const responseWithMarkers = "[$0] 2024年计划\n[$1] 100%成功";
    assert.deepEqual(parseWholeResponse(responseWithMarkers, 2), ["2024年计划", "100%成功"]);

    // Plain lines without markers: numbers at line start are plain text, not markers
    const responsePlain = "2024年计划\n100%成功";
    assert.deepEqual(parseWholeResponse(responsePlain, 2), ["2024年计划", "100%成功"]);
  });

  it("test_parse_partial_markers_mixed_with_headers_and_commentary", () => {
    const response = "Here are the translations:\n\n[$0] 正常翻译\n这是一段无关注释或解释\n[$2] 另一个正常翻译";
    const result = parseWholeResponse(response, 3);
    assert.deepEqual(result, ["正常翻译", "", "另一个正常翻译"]);
  });

  it("test_translate_subtitles_whole_flag", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "[$0] 你好\n[$1] 世界" } }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );

    try {
      const subs: SubtitleCue[] = [
        { start: 0, end: 0.5, text: "Hello" },
        { start: 0.6, end: 1.2, text: "world" },
      ];
      const result = await translateSubtitles(subs, "en", "zh-CN", {
        provider: "openai",
        apiKey: "sk",
        whole: true,
      });

      assert.equal(result.length, 2);
      assert.equal(result[0].translation, "你好");
      assert.equal(result[1].translation, "世界");
      assert.equal(result[0].text, "Hello");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("test_translate_subtitles_whole_false_still_batch", async () => {
    TRANSLATE_PROVIDERS["_t_"] = async (text) => `TR[${text}]`;
    try {
      const subs: SubtitleCue[] = [
        { start: 0, end: 0.5, text: "A" },
        { start: 0.6, end: 1.2, text: "B" },
      ];
      const result = await translateSubtitles(subs, "en", "zh-CN", {
        provider: "_t_",
        whole: false,
      });
      assert.equal(result[0].translation, "TR[A]");
      assert.equal(result[1].translation, "TR[B]");
    } finally {
      delete TRANSLATE_PROVIDERS["_t_"];
    }
  });

  it("test_translate_subtitles_empty", async () => {
    const result = await translateSubtitles([], "en", "zh-CN", {
      provider: "x",
      apiKey: "k",
      whole: true,
    });
    assert.deepEqual(result, []);
  });

  it("test_translate_whole_fallback_to_batch_on_garbage", async () => {
    const originalFetch = globalThis.fetch;
    let callCount = 0;

    globalThis.fetch = async (url: any, init: any) => {
      callCount++;
      const body = JSON.parse(init.body);
      const isChat = String(url).includes("/chat/completions");

      // First call (whole): return garbled text that won't parse
      if (isChat && callCount === 1) {
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: "Unrelated text here without matching markers" } }],
          }),
          { status: 200 }
        );
      }

      // Subsequent calls (batch fallback):
      const userText = body.messages[1].content;
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: `TR[${userText}]` } }],
        }),
        { status: 200 }
      );
    };

    try {
      const subs: SubtitleCue[] = [
        { start: 0, end: 1, text: "Sentence 1" },
        { start: 1, end: 2, text: "Sentence 2" },
      ];
      const result = await translateWhole(subs, "en", "zh-CN", {
        provider: "openai",
        apiKey: "sk",
        fallbackToBatch: true,
      });
      assert.equal(result.length, 2);
      assert.equal(result[0].translation, "TR[Sentence 1]");
      assert.equal(result[1].translation, "TR[Sentence 2]");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("test_translate_whole_chunksize_edge_cases_do_not_infinite_loop", { timeout: 5000 }, async () => {
    TRANSLATE_PROVIDERS["_t_"] = async (text) => `TR[${text}]`;
    try {
      const subs: SubtitleCue[] = [
        { start: 0, end: 1, text: "Line 1" },
        { start: 1, end: 2, text: "Line 2" },
      ];
      // chunkSize 0, negative, NaN should safely default to 12 and not infinite loop
      for (const chunkSize of [0, -1, NaN]) {
        const res = await translateWhole(subs, "en", "zh-CN", {
          provider: "_t_",
          chunkSize,
        });
        assert.equal(res.length, 2);
        assert.equal(res[0].translation, "TR[Line 1]");
        assert.equal(res[1].translation, "TR[Line 2]");
      }
    } finally {
      delete TRANSLATE_PROVIDERS["_t_"];
    }
  });
});

describe("Audio & Transcribe Modules", () => {
  it("test_split_audio_validation", async () => {
    for (const invalidChunkSeconds of [0, -5, NaN, Infinity]) {
      await assert.rejects(
        async () => {
          await splitAudio("/dummy/path.mp3", invalidChunkSeconds);
        },
        (err: any) => {
          assert.ok(err instanceof IngestError);
          assert.ok(err.message.includes("chunk_seconds must be greater than zero"));
          return true;
        }
      );
    }
  });

  it("test_transcribe_timed_chunks_validation", async () => {
    const client = new WhisperClient({ apiKey: "test-key" });
    for (const invalidChunkSeconds of [0, -5, NaN, Infinity]) {
      await assert.rejects(
        async () => {
          await transcribeTimedChunks(["chunk_001.mp3"], client, "en", invalidChunkSeconds);
        },
        (err: any) => {
          assert.ok(err instanceof IngestError);
          assert.ok(err.message.includes("chunk_seconds must be greater than zero"));
          return true;
        }
      );
    }
  });

  it("test_whisper_client_requires_api_key", () => {
    const prevKey = process.env.WHISPER_API_KEY;
    const prevGroq = process.env.GROQ_API_KEY;
    const prevOpenAI = process.env.OPENAI_API_KEY;
    delete process.env.WHISPER_API_KEY;
    delete process.env.GROQ_API_KEY;
    delete process.env.OPENAI_API_KEY;

    try {
      assert.throws(
        () => new WhisperClient(),
        (err: any) => {
          assert.ok(err instanceof IngestError);
          assert.ok(err.message.includes("Set WHISPER_API_KEY"));
          return true;
        }
      );
    } finally {
      if (prevKey) process.env.WHISPER_API_KEY = prevKey;
      if (prevGroq) process.env.GROQ_API_KEY = prevGroq;
      if (prevOpenAI) process.env.OPENAI_API_KEY = prevOpenAI;
    }
  });

  it("test_fallback_segments_distribution", () => {
    const text = "First sentence! Second sentence? Third sentence.";
    const segments = fallbackSegments(text, 30);
    assert.equal(segments.length, 3);
    assert.equal(segments[0].text, "First sentence!");
    assert.equal(segments[0].start, 0);
    assert.equal(segments[2].end, 30);
    assert.ok(segments[1].start >= segments[0].end);
  });

  it("test_fallback_segments_empty", () => {
    const segments = fallbackSegments("   ", 10);
    assert.deepEqual(segments, []);
  });

  it("test_whisper_timed_chunks_offset_calculation", async () => {
    const client = new WhisperClient({ apiKey: "test-key" });
    // Mock transcribeTimed
    client.transcribeTimed = async (chunkPath: string) => {
      return {
        text: "Segment from " + chunkPath,
        segments: [
          { start: 1.0, end: 4.5, text: "Hello" },
          { start: 5.0, end: 8.0, text: "World" },
        ],
        duration: 10.0,
      };
    };

    const cues = await transcribeTimedChunks(["chunk_001.mp3", "chunk_002.mp3"], client, "en", 600);
    assert.equal(cues.length, 4);

    // Chunk 0 offsets
    assert.equal(cues[0].start, 1.0);
    assert.equal(cues[0].end, 4.5);
    assert.equal(cues[0].text, "Hello");
    assert.equal(cues[1].start, 5.0);
    assert.equal(cues[1].end, 8.0);
    assert.equal(cues[1].text, "World");

    // Chunk 1 offsets (600 + start/end)
    assert.equal(cues[2].start, 601.0);
    assert.equal(cues[2].end, 604.5);
    assert.equal(cues[3].start, 605.0);
    assert.equal(cues[3].end, 608.0);
  });
});

describe("HTTP Timeout on Stalled Response Body", () => {
  it("translateSingle times out when server sends headers but stalls body", { timeout: 5000 }, async t => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.flushHeaders?.();
      // Intentionally do not end the response or write body
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as any).port;

    try {
      const start = Date.now();
      await assert.rejects(
        async () => {
          t.after(trustModelEndpoint(`http://127.0.0.1:${port}`));
          await translateSingle("Hello", "en", "zh-CN", {
            provider: "openai",
            apiKey: "sk-test",
            baseUrl: `http://127.0.0.1:${port}`,
            timeout: 0.15,
          });
        },
        (err: any) => {
          assert.ok(err instanceof TranslateError);
          assert.ok(err.message.includes("timed out"));
          return true;
        }
      );
      const elapsed = Date.now() - start;
      assert.ok(elapsed < 2000, `Expected timeout to abort quickly, took ${elapsed}ms`);
    } finally {
      server.close();
    }
  });

  it("translateStream times out when server sends headers but stalls body", { timeout: 5000 }, async t => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.flushHeaders?.();
      // Intentionally do not write any events or end
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as any).port;

    try {
      const start = Date.now();
      await assert.rejects(
        async () => {
          t.after(trustModelEndpoint(`http://127.0.0.1:${port}`));
          for await (const _ of translateStream("Hello", "en", "zh-CN", {
            provider: "openai",
            apiKey: "sk-test",
            baseUrl: `http://127.0.0.1:${port}`,
            timeout: 0.15,
          })) {
            // consume
          }
        },
        (err: any) => {
          assert.ok(err instanceof TranslateError);
          assert.ok(err.message.includes("timed out"));
          return true;
        }
      );
      const elapsed = Date.now() - start;
      assert.ok(elapsed < 2000, `Expected stream timeout to abort quickly, took ${elapsed}ms`);
    } finally {
      server.close();
    }
  });

  it("WhisperClient times out when server sends headers but stalls body", { timeout: 5000 }, async () => {
    const tmpFile = path.join(os.tmpdir(), `dummy-audio-${Date.now()}.mp3`);
    await fs.writeFile(tmpFile, "dummy audio content");

    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.flushHeaders?.();
      // Stalls
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as any).port;

    const client = new WhisperClient({
      apiKey: "test-whisper",
      baseUrl: `http://127.0.0.1:${port}`,
      timeoutSeconds: 0.15,
      retries: 1,
    });

    try {
      const start = Date.now();
      await assert.rejects(
        async () => {
          await client.transcribe(tmpFile);
        },
        (err: any) => {
          assert.ok(err instanceof IngestError);
          assert.ok(err.message.includes("timed out"));
          return true;
        }
      );
      const elapsed = Date.now() - start;
      assert.ok(elapsed < 2000, `Expected whisper timeout to abort quickly, took ${elapsed}ms`);
    } finally {
      server.close();
      try {
        await fs.unlink(tmpFile);
      } catch {}
    }
  });
});

