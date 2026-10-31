import type { ServerResponse } from "node:http";

/** OpenAI SSE fixture. Tests must exercise the wire protocol used by pi. */
export function modelChunk(res: ServerResponse, delta: Record<string, unknown>, finishReason: string | null = null): void {
  if (!res.headersSent) res.setHeader("Content-Type", "text/event-stream");
  res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`);
}

export function endModelStream(res: ServerResponse, finishReason = "stop"): void {
  modelChunk(res, {}, finishReason);
  res.end("data: [DONE]\n\n");
}

export function sendModelJson(res: ServerResponse, answer: unknown): void {
  const content = JSON.stringify(answer);
  // Split the JSON across deltas, including Chinese text and escaped strings.
  for (let i = 0; i < content.length; i += 17) modelChunk(res, { content: content.slice(i, i + 17) });
  endModelStream(res);
}
