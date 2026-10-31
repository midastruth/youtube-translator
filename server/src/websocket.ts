/** WebSocket delivery boundary for /ws/subtitle/process. */
import type http from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, WebSocket } from "ws";
import {
  processSubtitleFlow, resolveDependencies, validateSubtitleRequest,
  type AppDependencies, type ResolvedDependencies,
} from "./app.js";
import { getTranslationProfile } from "./cache.js";
import { translateStream } from "./translate.js";
import { sendWebSocket } from "./streaming.js";
import type { SubtitleRequest } from "./types.js";

export function attachWebSocket(server: http.Server, deps?: Partial<AppDependencies> | ResolvedDependencies): () => Promise<void> {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 10 * 1024 * 1024 });
  let resolvedPromise: Promise<ResolvedDependencies> | undefined;
  const getResolved = () => resolvedPromise ??= resolveDependencies(deps);

  const onUpgrade = (request: http.IncomingMessage, socket: Duplex, head: Buffer) => {
    // Upgrade boundary: invalid request targets cannot be translated to WS frames.
    try {
      const url = new URL(request.url || "/", "http://localhost");
      if (url.pathname !== "/ws/subtitle/process") {
        socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
        return;
      }
      wss.handleUpgrade(request, socket, head, ws => wss.emit("connection", ws, request));
    } catch {
      socket.destroy();
    }
  };
  server.on("upgrade", onUpgrade);

  wss.on("connection", (ws: WebSocket) => {
    const controller = new AbortController();
    ws.on("close", () => controller.abort());
    ws.on("error", () => controller.abort());
    const signal = controller.signal;
    const send = (data: unknown) => sendWebSocket(ws, JSON.stringify(data));
    let handled = false;

    const processMessage = async (raw: string) => {
      try {
        let body: SubtitleRequest;
        try {
          body = JSON.parse(raw);
        } catch (cause) {
          // Decode boundary: retain context, never substitute a fallback body.
          throw new Error("Invalid JSON format", { cause });
        }
        validateSubtitleRequest(body);
        const resolved = await getResolved();
        const { meta, cues } = await processSubtitleFlow(body, resolved);
        signal.throwIfAborted();
        const toLang = body.translate_to;

        if (toLang && cues.length && (body.translate_engine === "document" || body.translate_engine === "agent")) {
          const job = await resolved.worker.submitOrAttachJob({
            cues, videoId: meta.video_id, title: meta.title, fromLang: meta.from_lang, toLang,
            segmentation: body.segmentation || "rule", provider: body.translate_provider || "openai",
            model: body.translate_model || undefined, baseUrl: body.translate_base_url,
            apiKey: body.translate_api_key, engine: body.translate_engine,
            contextTokens: body.translate_context_tokens, outputTokens: body.translate_output_tokens,
          });
          // Disconnect only detaches this observer; the document job is durable.
          for await (const event of resolved.worker.observeJobStream(job, { signal, heartbeatIntervalMs: 5000 })) {
            signal.throwIfAborted();
            if (event.type !== "keepalive") await send(event);
          }
          return;
        }

        await send({ type: "meta", ...meta, to_lang: toLang, segmentation: body.segmentation || "rule", total_cues: cues.length });
        for (let index = 0; index < cues.length; index++) {
          await send({ type: "source_cue", index, ...cues[index], cue_id: cues[index].cue_id || `c${index}` });
        }
        if (!toLang || !cues.length) {
          for (let index = 0; index < cues.length; index++) {
            await send({ type: "cue", index, ...cues[index], cue_id: cues[index].cue_id || `c${index}`, translation: cues[index].translation || "" });
          }
          await send({ type: "done", total_cues: cues.length, failed_cues: 0 });
          return;
        }

        const useWhole = Boolean(body.translate_whole);
        const profileKey = getTranslationProfile({
          cues, provider: body.translate_provider, baseUrl: body.translate_base_url, model: body.translate_model,
          strategy: `websocket-stream-${useWhole ? "whole" : "cue-chunk"}-v1`, engine: "legacy",
          fromLang: meta.from_lang, toLang, segmentation: body.segmentation || "rule",
        });
        const working = cues.map(c => ({ ...c }));
        const cached = await resolved.cache.getTranslation(meta.video_id, meta.from_lang, body.segmentation || "rule", toLang, profileKey);
        const validCache = Array.isArray(cached) && cached.length === working.length && cached.every((c, i) => c.text === working[i].text);
        const fullyCached = validCache && cached.every(c => c.translation && c.translation !== "[Translation failed]");
        const options = {
          provider: body.translate_provider, apiKey: body.translate_api_key,
          baseUrl: body.translate_base_url, model: body.translate_model, signal,
        };
        const putCache = () => resolved.cache.putTranslation(meta.video_id, meta.from_lang, body.segmentation || "rule", toLang, profileKey, working);
        let failedCount = 0;

        if (fullyCached) {
          for (let index = 0; index < cached.length; index++) {
            await send({ type: "cue", index, ...cached[index], cue_id: cached[index].cue_id || `c${index}`, cached: true });
          }
        } else if (useWhole) {
          const translated = await resolved.translateSubtitles(working, meta.from_lang, toLang, { ...options, whole: true });
          for (let index = 0; index < translated.length; index++) {
            working[index] = translated[index];
            if (!working[index].translation || working[index].translation === "[Translation failed]") failedCount++;
            await send({ type: "cue", index, ...working[index], cue_id: working[index].cue_id || `c${index}` });
          }
          if (!failedCount) await putCache();
        } else {
          const streamFn = (deps as AppDependencies & { translateStream?: typeof translateStream })?.translateStream || translateStream;
          for (let index = 0; index < working.length; index++) {
            signal.throwIfAborted();
            const cue = working[index];
            const cachedValue = validCache ? (cached[index]?.translation || "").trim() : "";
            if (cachedValue && cachedValue !== "[Translation failed]") {
              cue.translation = cachedValue;
              await send({ type: "cue", index, ...cue, cue_id: cue.cue_id || `c${index}`, cached: true });
              continue;
            }
            cue.translation = "";
            if (cue.text.trim()) {
              // Provider failures propagate to the WS error boundary; never hide
              // decoding, transport or cache errors behind successful cue events.
              for await (const chunk of streamFn(cue.text, meta.from_lang, toLang, options)) {
                signal.throwIfAborted();
                cue.translation += chunk;
                await send({ type: "cue_chunk", index, text: cue.text, translation: cue.translation });
              }
              if (!cue.translation) failedCount++;
            }
            await send({ type: "cue", index, ...cue, cue_id: cue.cue_id || `c${index}` });
            if (!failedCount) await putCache();
          }
        }
        await send({ type: "done", total_cues: cues.length, failed_cues: failedCount });
      } catch (error) {
        // Request boundary: translate validation/provider/storage errors to an
        // explicit WS error. Disconnected clients cannot receive a response.
        if (!signal.aborted && ws.readyState === WebSocket.OPEN) {
          await send({ type: "error", detail: error instanceof Error ? error.message : String(error) });
        }
      } finally {
        if (ws.readyState === WebSocket.OPEN) ws.close();
      }
    };
    ws.on("message", raw => {
      if (handled) return;
      handled = true;
      // Final transport boundary: if even the error response fails, terminate.
      void processMessage(raw.toString("utf8")).catch(() => ws.terminate());
    });
  });

  return async () => {
    server.removeListener("upgrade", onUpgrade);
    for (const client of wss.clients) client.terminate();
    await new Promise<void>((resolve, reject) => wss.close(error => error ? reject(error) : resolve()));
  };
}
