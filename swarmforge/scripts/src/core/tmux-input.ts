// Keys used to submit injected text to an interactive agent.
export function submitKeys(agent: string): string[] {
  // With extended keys enabled, C-m is Ctrl+M, not Enter. Pi also treats
  // C-j as a newline, so send an actual Enter without the legacy LF fallback.
  return agent.toLowerCase() === "pi" ? ["Enter"] : ["C-m", "C-j"];
}
