import { normalizeContext } from "@earendil-works/pi-ai";
import type { AssistantMessage, Context, Model } from "@earendil-works/pi-ai";
import { stream } from "@earendil-works/pi-ai/api/openai-completions";
import type { SourceCue } from "./domain-types.js";
import { modelEndpoint } from "./model-endpoint.js";
import { createHash } from "node:crypto";

export class DocumentPermanentError extends Error {
  readonly code: "configuration" | "budget" | "convergence";
  constructor(code: "configuration" | "budget" | "convergence", message: string) {
    super(message); this.code = code;
  }
}

export type ReasoningEffort = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
export type ModelConfig = {
  model: string; baseUrl: string; contextTokens: number; outputTokens: number;
  // Optional for checkpoints created before reasoning was configurable.
  reasoningEffort?: ReasoningEffort;
};
export type DocumentInput = {
  jobId: string; jobKey: string; videoId: string; title: string; fromLang: string; toLang: string;
  cues: SourceCue[]; config: ModelConfig; budgetLimit: number;
  // Shared per manual run; absent in older checkpoints (unlimited).
  tokenBudget?: number;
  // Snapshotted per-role settings. Older team tasks inherit their persisted global effort.
  teamReasoning?: { main: ReasoningEffort; subagent: ReasoningEffort };
  // New team jobs require a dedicated opening assignment. Absent in old team tasks.
  streamOpening?: boolean;
  // Explicit retry of a failed task restores its conversation's saved checkpoint.
  resume?: boolean;
};

// Conservative estimates, not a tokenizer guarantee. Both input and output keep headroom.
export function tokenEstimate(value: unknown): number {
  return Math.ceil(Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value), "utf8") / 2) + 32;
}
export function outputEstimate(cues: SourceCue[]) {
  return cues.reduce((n, c) => n + Math.ceil(Buffer.byteLength(c.text, "utf8") * 1.5) + c.cue_id.length + 48, 128);
}
export function inputBudget(config: ModelConfig) {
  return Math.floor(config.contextTokens * 0.8) - config.outputTokens - 1500;
}
export function outputBudget(config: ModelConfig) { return Math.floor(config.outputTokens * 0.7); }
export function parseReasoningEffort(value: unknown, setting = "TRANSLATION_REASONING_EFFORT"): ReasoningEffort {
  if (!["off", "minimal", "low", "medium", "high", "xhigh"].includes(value as string)) {
    throw new DocumentPermanentError("configuration", `Invalid ${setting}; use off, minimal, low, medium, high or xhigh`);
  }
  return value as ReasoningEffort;
}
export function modelConfig(options: Partial<ModelConfig> = {}): ModelConfig {
  const config = {
    model: options.model || process.env.TRANSLATION_AGENT_MODEL || "sol",
    baseUrl: modelEndpoint(options.baseUrl),
    contextTokens: options.contextTokens ?? Number(process.env.TRANSLATION_CONTEXT_TOKENS || 128000),
    outputTokens: options.outputTokens ?? Number(process.env.TRANSLATION_OUTPUT_TOKENS || 16384),
    reasoningEffort: parseReasoningEffort(options.reasoningEffort ?? (process.env.TRANSLATION_REASONING_EFFORT || "off")),
  };
  if (!Number.isSafeInteger(config.contextTokens) || !Number.isSafeInteger(config.outputTokens) ||
      config.outputTokens < 512 || inputBudget(config) < 1024) throw new Error("Invalid model context/output token limits");
  return config;
}

export class DocumentModelError extends Error {
  readonly status: number;
  readonly retryAfterMs: number;
  constructor(status: number, retryAfterMs = 1000) {
    super(`Model API HTTP ${status}${[401, 403].includes(status) ? ": check credentials" : ""}`);
    this.status = status; this.retryAfterMs = retryAfterMs;
  }
}

const STREAM_FAILURES = {
  connection: "无法连接模型接口；请检查服务端网络、代理、TLS 和 OPENAI_BASE_URL（不允许重定向）",
  invalid_response: "模型接口返回了 JSON/HTML 而不是 SSE 流；请检查 OPENAI_BASE_URL 是否为 API 根路径，以及接口是否支持 stream:true",
  missing_finish_reason: "模型流缺少 finish_reason 结束标志；可能被网关截断或接口不兼容，请检查上游 SSE 实现与代理超时",
  content_filter: "模型服务因内容过滤终止输出；请检查上游内容策略或更换模型",
  network_error: "模型服务报告 network_error；请检查上游服务和网关连接后重试",
  provider_error: "模型流发生连接或协议错误；请确认接口支持 /chat/completions SSE 和工具调用，并检查上游服务日志",
} as const;

/** Only static, allowlisted diagnostics may enter durable state or browser errors. */
export class DocumentStreamError extends Error {
  readonly code: keyof typeof STREAM_FAILURES;
  constructor(code: keyof typeof STREAM_FAILURES) {
    super(`Model API stream failed [${code}]: ${STREAM_FAILURES[code]}`);
    this.code = code;
  }
}

export type ModelCallOptions = {
  apiKey?: string; signal?: AbortSignal; reserve: () => Promise<void>; cacheKey?: string;
  recordTokens?: (tokens: number) => Promise<void>;
};

/** Cached input counts too; output already includes hidden reasoning tokens. */
export function turnTokenUsage(response: AssistantMessage, context: Context, outputTokens: number): number {
  const usage = response.usage;
  const total = usage && usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
  if (Number.isSafeInteger(total) && total > 0) return total;
  // Missing usage must not bypass the budget; conservatively charge the full
  // output allowance for unmetered turns, including failed/truncated streams.
  return tokenEstimate(context) + outputTokens;
}

/** Stable per job+agent, at most 64 chars (OpenAI prompt_cache_key limit), and reveals no job data. */
export function promptCacheSession(input: DocumentInput, agent = "main") {
  return `st-${createHash("sha256").update(`${input.jobKey}\0${agent}`).digest("hex").slice(0, 40)}`;
}

/** One complete, budgeted provider turn. The caller owns tools and durable conversation state. */
export async function callDocumentTurn(input: DocumentInput, context: Context, options: ModelCallOptions) {
  const apiKey = options.apiKey || process.env.OPENAI_API_KEY || process.env.TRANSLATE_API_KEY;
  if (!apiKey) throw new DocumentPermanentError("configuration", "全文翻译需要 OpenAI-compatible API Key；请在扩展或 Worker 环境变量中配置");
  // Revalidate persisted inputs too: a restored job must obey current policy.
  const baseUrl = modelEndpoint(input.config.baseUrl);
  // Use the persisted setting, not a possibly changed deployment environment.
  // Old team checkpoints keep their original non-reasoning request format.
  const effort = parseReasoningEffort(input.config.reasoningEffort ?? "off");
  const reasoning = effort !== "off";
  const model: Model<"openai-completions"> = {
    id: input.config.model, name: input.config.model, api: "openai-completions", provider: "subtitle-model",
    baseUrl, reasoning, input: ["text"], contextWindow: input.config.contextTokens,
    maxTokens: input.config.outputTokens, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    compat: {
      maxTokensField: reasoning ? "max_completion_tokens" : "max_tokens", supportsStore: false,
      ...(reasoning ? { thinkingFormat: "openai", supportsReasoningEffort: true } : {}),
    },
  };
  if (tokenEstimate(context) > inputBudget(input.config)) throw new DocumentPermanentError("budget", "Conversation exceeds context budget; reduce requested context");
  options.signal?.throwIfAborted();
  await options.reserve();
  // Consume the provider's SSE stream, including fragmented tool calls.
  const signal = AbortSignal.any([AbortSignal.timeout(600000), ...(options.signal ? [options.signal] : [])]);
  let httpError: DocumentModelError | undefined;
  let transportError: DocumentStreamError | undefined;
  const events = stream(model, normalizeContext(context), {
    apiKey, signal, timeoutMs: 600000, maxTokens: input.config.outputTokens,
    // Route every turn of one agent to the same provider cache (prompt_cache_key /
    // session-affinity headers where pi-ai supports them for this endpoint).
    sessionId: promptCacheSession(input, options.cacheKey),
    // Let pi-ai serialize OpenAI's reasoning_effort. Reasoning models may reject
    // custom temperatures; their completion cap includes hidden reasoning tokens.
    ...(effort === "off" ? { temperature: 0.1 } : { reasoningEffort: effort }),
    // Retries belong to the durable task so every network attempt reserves budget.
    maxRetries: 0,
    fetch: async (url, init) => {
      // SDK defaults must not weaken endpoint policy or forward keys on redirects.
      let result: Response;
      try { result = await fetch(url, { ...init, redirect: "error" }); }
      catch {
        transportError = new DocumentStreamError("connection");
        throw transportError;
      }
      if (!result.ok) {
        const retryAfter = result.headers.get("retry-after") || "";
        const seconds = Number(retryAfter);
        const delay = retryAfter ? (Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - Date.now()) : 1000;
        httpError = new DocumentModelError(result.status, Number.isFinite(delay) ? Math.min(30000, Math.max(1000, delay)) : 1000);
      } else {
        // A gateway may return an HTML login page or a non-streaming JSON
        // response with HTTP 200. Do not read or persist that private body.
        const contentType = result.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
        if (contentType === "text/html" || contentType === "application/json" || contentType?.endsWith("+json")) {
          transportError = new DocumentStreamError("invalid_response");
          await result.body?.cancel().catch(() => {});
          throw transportError;
        }
      }
      return result;
    },
  });
  // No tool execution or publication until the entire stream has finished safely.
  for await (const _event of events) { /* Final response is checked below. */ }
  const response = await events.result();
  await options.recordTokens?.(turnTokenUsage(response, context, input.config.outputTokens));
  // pi returns failures as messages, not rejected promises. Never parse partial
  // output or persist its raw errorMessage: provider bodies may contain secrets.
  options.signal?.throwIfAborted();
  if (httpError) throw httpError;
  if (signal.aborted) throw new Error("Model API request timed out after 600s");
  if (transportError) throw transportError;
  if (response.stopReason === "error" || response.stopReason === "aborted") {
    const code = response.rawStopReason === "content_filter" ? "content_filter"
      : response.rawStopReason === "network_error" ? "network_error"
      : response.errorMessage === "Stream ended without finish_reason" ? "missing_finish_reason"
      : "provider_error";
    throw new DocumentStreamError(code);
  }
  if (response.stopReason === "length") throw new Error("Model output missing or truncated; increase output limit or edit smaller batches");
  return response;
}
