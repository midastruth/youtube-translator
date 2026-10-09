import { build } from "esbuild";
import { readdir, mkdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";

execFileSync(process.execPath, ["node_modules/typescript/bin/tsc", "--pretty", "false"], { stdio: "inherit" });
const extensionOnly = process.argv.includes("--extension");
if (!extensionOnly) {
  const entries = (await readdir("worker")).filter(name => name.endsWith(".ts")).map(name => `worker/${name}`);
  await build({ entryPoints: entries, outdir: "dist/worker", platform: "node", format: "esm", target: "node22", sourcemap: true });
}
await mkdir("minimal-extension/public", { recursive: true });
await build({
  entryPoints: ["background", "bridge", "content", "options"].map(name => `minimal-extension/src/${name}.ts`),
  outdir: "minimal-extension/public", bundle: true, platform: "browser", format: "iife",
  target: ["chrome121", "firefox128"], sourcemap: true,
});
