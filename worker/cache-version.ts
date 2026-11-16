import { createHash } from "node:crypto";

/** Content-address the model-facing contract, independent of object property order. */
export function contentVersion(prefix: string, contract: unknown): string {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonical(item)]));
    }
    return value;
  };
  return `${prefix}-${createHash("sha256").update(JSON.stringify(canonical(contract))).digest("hex").slice(0, 24)}`;
}
