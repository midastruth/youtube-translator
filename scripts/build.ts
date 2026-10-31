import { build } from "esbuild";
import { readdir, mkdir, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";

execFileSync(process.execPath, ["node_modules/typescript/bin/tsc", "--pretty", "false"], { stdio: "inherit" });
const extensionOnly = process.argv.includes("--extension");
if (!extensionOnly) {
  await rm("dist/worker", { recursive: true, force: true });
  await rm("dist/server", { recursive: true, force: true });
  const workerEntries = (await readdir("worker")).filter(name => name.endsWith(".ts")).map(name => `worker/${name}`);
  await build({ entryPoints: workerEntries, outdir: "dist/worker", platform: "node", format: "esm", target: "node22", sourcemap: true });

  const serverEntries = (await readdir("server/src")).filter(name => name.endsWith(".ts")).map(name => `server/src/${name}`);
  await build({ entryPoints: serverEntries, outdir: "dist/server/src", platform: "node", format: "esm", target: "node22", sourcemap: true });
}
await mkdir("extension/public", { recursive: true });
await build({
  entryPoints: ["background", "bridge", "content", "options"].map(name => `extension/src/${name}.ts`),
  outdir: "extension/public", bundle: true, platform: "browser", format: "iife",
  target: ["chrome121", "firefox128"], sourcemap: true,
});
