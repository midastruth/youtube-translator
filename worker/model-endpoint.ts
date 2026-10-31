/** Only the deployment may choose model destinations (including private providers).
 * Exact URL matching, not a hostname suffix allowlist, prevents callers from
 * selecting attacker-controlled DNS names, IPs, ports or paths. Redirects must
 * also be disabled at the HTTP call site; credentials never follow redirects.
 */
export function normalizeEndpoint(value: string): string {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("Model endpoint must be an HTTP(S) URL without credentials, query or fragment");
  }
  return url.href.replace(/\/+$/, "");
}

export function modelEndpoint(baseUrl?: string, provider = "openai"): string {
  const configured = provider === "deepl"
    ? "https://api-free.deepl.com/v2"
    : process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
  const trusted = normalizeEndpoint(configured);
  if (baseUrl && normalizeEndpoint(baseUrl) !== trusted) {
    throw new Error("Model endpoint is not trusted; configure OPENAI_BASE_URL on the server");
  }
  return trusted;
}
