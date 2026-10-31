import type { ServerResponse } from "node:http";
import { WebSocket } from "ws";

/** One outstanding write per producer; disconnects interrupt a blocked drain. */
export async function sendSSE(res: ServerResponse, data: unknown, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  if (res.destroyed || res.writableEnded) throw new Error("SSE connection closed");
  const frame = (data as { type?: string })?.type === "keepalive"
    ? ": keepalive\n\n" : `data: ${JSON.stringify(data)}\n\n`;
  if (res.write(frame)) return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      res.off("drain", drained); res.off("close", closed); res.off("error", failed);
      signal.removeEventListener("abort", aborted);
    };
    const drained = () => { cleanup(); resolve(); };
    const failed = (error: Error) => { cleanup(); reject(error); };
    const closed = () => failed(new Error("SSE connection closed"));
    const aborted = () => failed(signal.reason);
    res.once("drain", drained); res.once("close", closed); res.once("error", failed);
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) aborted();
  });
}

/** ws callbacks fire after the frame has been written, bounding queued output. */
export async function sendWebSocket(ws: WebSocket, data: string): Promise<void> {
  if (ws.readyState !== WebSocket.OPEN) throw new Error("WebSocket connection closed");
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => { ws.off("close", closed); ws.off("error", failed); };
    const failed = (error: Error) => { cleanup(); reject(error); };
    const closed = () => failed(new Error("WebSocket connection closed"));
    ws.once("close", closed); ws.once("error", failed);
    ws.send(data, error => { cleanup(); if (error) reject(error); else resolve(); });
  });
}

/** Heartbeats run while a provider call is pending, but never queue writes. */
export async function withHeartbeats<T>(pending: Promise<T>, heartbeat: () => Promise<void>, intervalMs = 5000): Promise<T> {
  const result = pending.then(value => ({ value }));
  while (true) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const next = await Promise.race([
        result,
        new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), intervalMs); }),
      ]);
      if (next) return next.value;
      await heartbeat();
    } finally {
      clearTimeout(timer);
    }
  }
}
