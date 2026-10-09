import assert from "node:assert/strict";
import { test } from "node:test";
import { moduleImports } from "./support/module-imports.js";

const workerCore = ["domain-types", "chunker", "default-draft", "glossary", "keys", "network", "request-budget", "quality-eval", "reviewer", "revision-prompt", "validator"];

test("worker core cannot import lifecycle, persistence, transport or framework types", () => {
  const allowed = new Set([...workerCore.map(name => `./${name}.js`), "node:crypto"]);
  for (const name of workerCore) {
    for (const dependency of moduleImports(`worker/${name}.ts`)) {
      assert.ok(allowed.has(dependency), `${name} must not depend on ${dependency}`);
    }
  }
});

test("HTTP adapter uses the application interface, not durable storage or task definitions", () => {
  assert.deepEqual(moduleImports("worker/server.ts").sort(), ["./agent-worker.js", "./types.js", "node:http"]);
});

test("browser subtitle policies cannot import browser entrypoints or worker framework", () => {
  const browserCore = ["captions", "subtitles", "stream-request", "subtitle-stream", "types"];
  const allowed = new Set(browserCore.map(name => `./${name}.js`));
  for (const name of browserCore) {
    for (const dependency of moduleImports(`minimal-extension/src/${name}.ts`)) {
      assert.ok(allowed.has(dependency), `${name} must not depend on ${dependency}`);
    }
  }
});
