// New audit records are JSON; existing EDN records remain readable during upgrades.
import { readFileSync } from "node:fs";
import { readEdn, type Edn } from "../core/edn-lite.ts";
import { writeFileAtomic } from "../core/fs-atomic.ts";
import { isoInstant } from "../core/time.ts";

export type AuditCandidate = { [key: string]: Edn };

function asRecord(value: unknown): Record<string, Edn> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, Edn>)
    : undefined;
}

export function readAuditCandidate(path: string): AuditCandidate | undefined {
  try {
    const text = readFileSync(path, "utf8");
    const value: unknown = path.endsWith(".json") ? JSON.parse(text) : readEdn(text);
    return asRecord(asRecord(value)?.candidate);
  } catch {
    return undefined;
  }
}

export function writeAudit(path: string, candidate: AuditCandidate): void {
  writeFileAtomic(path, `${JSON.stringify({ candidate, "created-at": isoInstant() })}\n`);
}
