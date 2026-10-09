import { readFileSync } from "node:fs";

/** Authored ESM declarations, including type-only imports and re-exports. */
export function moduleImports(path: string) {
  const declarations = /(?:import|export)\s+(?:type\s+)?(?:[^;'"]*?\s+from\s+)?["']([^"']+)["']/g;
  return [...readFileSync(path, "utf8").matchAll(declarations)].map(match => match[1]);
}
