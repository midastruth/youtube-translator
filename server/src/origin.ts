/** Browser origin boundary.
 *
 * The server spends deployment API keys on behalf of callers, so arbitrary web
 * pages must not be able to drive it from a visitor's browser (CSRF / drive-by
 * quota abuse). Browsers always send `Origin` on cross-origin fetch, POST and
 * WebSocket handshakes; we only accept the extension's contexts:
 *   - https://www.youtube.com  (Chrome content scripts use the page origin)
 *   - chrome-extension://*     (extension pages / Chrome)
 *   - moz-extension://*        (Firefox content scripts and extension pages)
 * Requests without `Origin` come from non-browser clients (curl, tests, the
 * extension's own same-origin contexts) and cannot be forged by web pages.
 *
 * Override with ALLOWED_ORIGINS (comma-separated; `scheme://*` matches any
 * host for that scheme, e.g. pin `chrome-extension://<id>` for stricter setups).
 */
import type http from "node:http";

const DEFAULT_ALLOWED_ORIGINS = "https://www.youtube.com,chrome-extension://*,moz-extension://*";

function allowedOriginPatterns(): string[] {
  const raw = process.env.ALLOWED_ORIGINS?.trim() || DEFAULT_ALLOWED_ORIGINS;
  return raw.split(",").map(p => p.trim().replace(/\/+$/, "").toLowerCase()).filter(Boolean);
}

export function isAllowedOrigin(origin: string): boolean {
  const value = origin.trim().replace(/\/+$/, "").toLowerCase();
  if (!value || value === "null") return false;
  return allowedOriginPatterns().some(pattern => {
    if (pattern === "*") return true;
    if (pattern.endsWith("://*")) {
      const scheme = pattern.slice(0, -1); // keep "scheme://"
      return value.startsWith(scheme) && /^[a-z0-9.-]+$/.test(value.slice(scheme.length));
    }
    return value === pattern;
  });
}

/** Returns the request Origin, `undefined` when absent, or `false` when rejected. */
export function checkRequestOrigin(req: http.IncomingMessage): string | undefined | false {
  const origin = req.headers.origin;
  if (origin === undefined) return undefined;
  return isAllowedOrigin(origin) ? origin : false;
}

export function setCorsHeaders(res: http.ServerResponse, origin?: string): void {
  res.setHeader("Vary", "Origin");
  if (!origin) return;
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept");
  res.setHeader("Access-Control-Max-Age", "600");
}
