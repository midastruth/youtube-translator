import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";

export const root = process.cwd();
export function command(args: string[], cwd = root): SpawnSyncReturns<string> {
  const result = spawnSync(args[0], args.slice(1), {
    cwd, encoding: "utf8", timeout: 120_000,
    env: { ...process.env, npm_config_cache: path.join(root, "tmp/npm-cache"), TMPDIR: path.join(root, "tmp") },
  });
  if (result.error) throw result.error;
  return result;
}
export function succeeds(result: SpawnSyncReturns<string>) {
  assert.equal(result.status, 0, result.stdout + result.stderr);
}
let installed = false;
export function installLockedDependencies() {
  if (installed) return;
  succeeds(command(["npm", "ci", "--no-audit", "--no-fund"]));
  installed = true;
}
export function cleanProjectCopy() {
  fs.mkdirSync(path.join(root, "tmp"), { recursive: true });
  const copy = fs.mkdtempSync(path.join(root, "tmp/migration-project-"));
  for (const name of ["worker", "minimal-extension", "features", "tests", "scripts", "docs", "package.json", "package-lock.json", "tsconfig.json", "Makefile"]) {
    fs.cpSync(path.join(root, name), path.join(copy, name), { recursive: true,
      filter: source => !(source.startsWith(path.join(root, "minimal-extension/public") + path.sep) && /\.js(?:\.map)?$/.test(source)),
    });
  }
  fs.symlinkSync(path.join(root, "node_modules"), path.join(copy, "node_modules"), "dir");
  return copy;
}
export function sourceFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(file) : [file];
  });
}
