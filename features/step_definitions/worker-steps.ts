import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import { After, Given, When, Then } from "@cucumber/cucumber";
import type { createWorkerServer as ServerFactory } from "../../worker/server.js";
import type { SourceCue, StreamEvent } from "../../worker/types.js";
import { calculateJobKey } from "../../worker/keys.js";
import { command, succeeds } from "../support/project.js";
import { eventually } from "../support/browser.js";

let directory = "";
let service: Awaited<ReturnType<typeof ServerFactory>> | undefined;
let processWorker: ChildProcess | undefined;
let base = "";
let portSetting = "";
let logs = "";
let text = "";
let translation = "";
let cue: SourceCue;
let submitted: { job_id: string; job_key: string; status: string };
let events: StreamEvent[] = [];
let snapshot: { published_cues: SourceCue[]; final_result: { cues: SourceCue[] } };
let key = "";
let built = false;

After(async () => {
  if (service) {
    service.server.closeAllConnections();
    await new Promise<void>(resolve => service!.server.close(() => resolve()));
    await service.worker.close(); service = undefined;
  }
  if (processWorker?.pid && processWorker.exitCode === null && processWorker.signalCode === null) {
    const child = processWorker;
    const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
    try { process.kill(-child.pid!, "SIGTERM"); } catch {}
    await exited; processWorker = undefined;
  }
  if (directory) fs.rmSync(directory, { recursive: true, force: true });
  directory = "";
});
Given("已安装锁定依赖并从 TS 源码构建 worker", () => {
  if (!built) { succeeds(command(["npm", "run", "build"])); built = true; }
  directory = fs.mkdtempSync(path.resolve("./tmp/worker-acceptance-"));
});
Given("TRANSLATION_AGENT_STORAGE 指向场景独占的临时数据库", () => { assert.ok(directory); });
Given(/^TRANSLATION_AGENT_PORT 配置为 "([^"]+)"$/, (value: string) => { portSetting = value; });
When("使用 npm run worker 启动真实服务", async () => {
  const env: NodeJS.ProcessEnv = { ...process.env, TRANSLATION_AGENT_STORAGE: path.join(directory, "storage.db"), npm_config_cache: path.resolve("./tmp/npm-cache") };
  if (portSetting === "未设置") delete env.TRANSLATION_AGENT_PORT;
  else env.TRANSLATION_AGENT_PORT = portSetting;
  logs = "";
  processWorker = spawn("npm", ["run", "worker"], { env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  processWorker.stdout?.on("data", (data: Buffer) => { logs += data.toString(); });
  processWorker.stderr?.on("data", (data: Buffer) => { logs += data.toString(); });
  await eventually(() => logs.includes("Durable translation worker listening"), logs, 60_000);
});
Then(/^服务在端口 (\d+) 响应 GET \/internal\/health 为 200 且 ready 为 true$/, async (port: string) => {
  base = `http://127.0.0.1:${port}`;
  const response = await fetch(`${base}/internal/health`);
  assert.equal(response.status, 200, logs);
  const data: unknown = await response.json();
  assert.deepEqual(data, { ready: true });
});
Then(/^GET \/internal\/jobs\/missing-job 响应 404 且 error 为 "([^"]+)"$/, async (error: string) => {
  const response = await fetch(`${base}/internal/jobs/missing-job`);
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error });
});
Given("构建后的内部 HTTP 服务使用场景独占数据库且就绪", async () => {
  const compiled = await import(pathToFileURL(path.resolve("dist/worker/server.js")).href) as { createWorkerServer: typeof ServerFactory };
  service = await compiled.createWorkerServer({ storagePath: path.join(directory, "storage.db"), port: 0 });
  await new Promise<void>(resolve => service!.server.listen(0, "127.0.0.1", resolve));
  const address = service.server.address(); assert.ok(address && typeof address !== "string");
  base = `http://127.0.0.1:${address.port}`;
  assert.equal((await fetch(`${base}/internal/health`)).status, 200);
});
Given(/^脚本化模型将源文 "([^"]+)" 翻译为 "([^"]+)" 并通过审校$/, (source: string, target: string) => {
  text = source; translation = target;
  assert.ok(service);
  const original = service.worker.submitOrAttachJob.bind(service.worker);
  service.worker.submitOrAttachJob = options => original({ ...options,
    translatorMock: async ({ cues }) => Object.fromEntries(cues.map(c => [c.cue_id, translation])),
    reviewerMock: async () => ({ passed: true, issues: [] }),
  });
});
When(/^向 POST \/internal\/jobs 提交 cue_id 为 "([^"]+)"、start 为 (\d+)、end 为 (\d+) 的该源字幕$/, async (cue_id: string, start: string, end: string) => {
  cue = { cue_id, start: Number(start), end: Number(end), text };
  const response = await fetch(`${base}/internal/jobs`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ videoId: "migration-video", cues: [cue] }) });
  assert.equal(response.status, 200);
  submitted = await response.json();
});
Then("响应为 200 且包含非空的 job_id、job_key 和 status", () => {
  for (const value of [submitted.job_id, submitted.job_key, submitted.status]) assert.ok(typeof value === "string" && value.length > 0);
});
Then("使用返回的 job_id 读取字幕流最终得到成功 cue 和 done", async () => {
  const response = await fetch(`${base}/internal/jobs/${submitted.job_id}/stream`);
  assert.equal(response.status, 200);
  const data = await response.text();
  events = data.split("\n\n").filter(frame => frame.startsWith("data: ")).map(frame => JSON.parse(frame.slice(6)) as StreamEvent);
  assert.ok(events.some(event => event.type === "cue"));
  assert.equal(events.at(-1)?.type, "done");
});
Then(/^成功 cue 的 cue_id、text、start、end 与提交值一致且 translation 为 "([^"]+)"$/, (target: string) => {
  const event = events.find(event => event.type === "cue"); assert.ok(event);
  assert.deepEqual({ cue_id: event.cue_id, start: event.start, end: event.end, text: event.text, translation: event.translation }, { ...cue, translation: target });
});
Then("done 的 total_cues 为 1 且 failed_cues 为 0", () => {
  const event = events.find(event => event.type === "done"); assert.ok(event);
  assert.equal(event.total_cues, 1); assert.equal(event.failed_cues, 0);
});
Then(/^使用返回的 job_id 读取快照响应为 200 且 status 为 "([^"]+)"$/, async (status: string) => {
  const response = await fetch(`${base}/internal/jobs/${submitted.job_id}`);
  assert.equal(response.status, 200);
  const data = await response.json(); assert.equal(data.status, status); snapshot = data;
});
Then("快照的 published_cues 与 final_result 包含同一条完整字幕", () => {
  assert.deepEqual(snapshot.published_cues, [{ ...cue, translation }]);
  assert.deepEqual(snapshot.final_result.cues, [{ ...cue, index: 0, translation }]);
});
Given(/^视频为 "([^"]+)" 且源字幕为 c0、100 毫秒到 1100 毫秒、文本 "([^"]+)"$/, (video: string, source: string) => {
  cue = { cue_id: "c0", start: 100, end: 1100, text: source };
  assert.equal(video, "migration-video");
});
Given("任务缓存配置使用迁移前 keys 模块的默认值", () => {});
When("使用迁移后的实际缓存键函数计算 job_key", () => { key = calculateJobKey({ videoId: "migration-video", sourceCues: [cue] }); });
Then(/^job_key 精确等于迁移前冻结的 "([^"]+)"$/, (expected: string) => { assert.equal(key, expected); });
