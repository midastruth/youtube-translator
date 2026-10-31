import assert from "node:assert/strict";
import { After, Given, When, Then } from "@cucumber/cucumber";
import { BrowserFixture } from "../support/browser.js";
import { AgentWorker } from "../../worker/agent-worker.js";

let browser: BrowserFixture | undefined;
let engines: string[] = [];
let rejection: unknown;

After(() => { browser?.close(); browser = undefined; rejection = undefined; });
Given("打开构建后的翻译设置页", () => { browser = new BrowserFixture(); });
When("读取可选择的翻译引擎", () => {
  const document = browser!.options();
  engines = [...document.querySelectorAll<HTMLSelectElement>("#translateEngine option")].map(option => option.value);
});
Then("只提供 document 多 Agent 和 legacy 快速模式", () => {
  assert.deepEqual(engines, ["document", "legacy"]);
});
When("向 Worker 提交已删除的 agent 引擎", async () => {
  try { await new AgentWorker().submitOrAttachJob({ engine: "agent" }); }
  catch (error) { rejection = error; }
});
Then("明确拒绝而不是回退到旧原型或快速模式", () => {
  assert.ok(rejection instanceof Error);
  assert.match(rejection.message, /only supports the document engine/);
});
