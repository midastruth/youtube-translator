import type { StreamRequest, SubtitleEvent } from "./types.js";

function consumeFrame(frame: string, onEvent: (event: SubtitleEvent) => void) {
  const data = frame.split("\n")
    .filter(line => line.startsWith("data:"))
    .map(line => line.slice(5).trimStart())
    .join("\n");
  if (data) onEvent(JSON.parse(data));
}

export async function consumeSubtitleStream(stream: ReadableStream<Uint8Array>, onEvent: (event: SubtitleEvent) => void) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    buffer = buffer.replace(/\r\n/g, "\n");
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      consumeFrame(buffer.slice(0, boundary), onEvent);
      buffer = buffer.slice(boundary + 2);
      boundary = buffer.indexOf("\n\n");
    }
    if (done) break;
  }
  if (buffer.trim()) consumeFrame(buffer, onEvent);
}

export async function apiStream(baseUrl: string, path: string, body: StreamRequest, signal: AbortSignal, onEvent: (event: SubtitleEvent) => void) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "text/event-stream" },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.detail || `Backend ${response.status}`);
  }
  if (!response.body) throw new Error("浏览器不支持流式字幕响应");
  await consumeSubtitleStream(response.body, onEvent);
}
