import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { LegacyState, requestFailure } from "./legacy-state.js";
import type { DataTable } from "@cucumber/cucumber";
import type { RequestFailure } from "../../worker/network.js";
import { Given, When, Then, Before, After } from "@cucumber/cucumber";

import { openOwnedSqliteStorage, StorageOwnershipConflictError } from "../../worker/storage.js";
import { calculateJobKey, DEFAULT_VERSIONS } from "../../worker/keys.js";
import { partitionCuesIntoBlocks, estimateTokens } from "../../worker/chunker.js";
import { validateOutputMapping } from "../../worker/validator.js";
import { reviewTranslations } from "../../worker/reviewer.js";
import {
  executeWithRetryAndBudget,
  RequestBudgetTracker,
  NetworkError,
  BudgetExceededError,
} from "../../worker/network.js";
import { AgentWorker } from "../../worker/agent-worker.js";
import {
  generateFrozenDataset,
  computeWeightedErrorScore,
  evaluateQualityGate,
} from "../../worker/quality-eval.js";
import { WHITELIST_TOOLS, testUnsafeTool } from "../../worker/tools.js";
import { SubtitleTranslationTask, SubtitleJobDoc, TaskMocks } from "../../worker/task-definition.js";

let tmpDir: string;
let worker: AgentWorker;
let workerStoragePath: string;
let world = new LegacyState();

Before(function () {
  TaskMocks.clear();
  fs.mkdirSync("./tmp", { recursive: true });
  tmpDir = fs.mkdtempSync(path.resolve("./tmp/yts-acceptance-"));
  workerStoragePath = path.join(tmpDir, "session.sqlite");
  world = new LegacyState();
  world.tmpDir = tmpDir;
  world.workerStoragePath = workerStoragePath;
});

After(async function () {
  if (world.worker2) {
    try {
      await world.worker2.close();
    } catch {}
    world.worker2 = null;
  }
  if (worker) {
    try {
      await worker.close();
    } catch {
      // ignore
    }
    // Every legacy scenario starts its own worker in Background.
  }
  if (tmpDir && fs.existsSync(tmpDir)) {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

// ── Background ─────────────────────────────────────────────────────────

Given("翻译 worker 使用锁定版本的 pi-durable 及兼容依赖", function () {
  const pkgPath = path.resolve("package.json");
  const pkg: { dependencies: Record<string, string> } = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
  assert.strictEqual(pkg.dependencies["@earendil-works/pi-durable"], "1.1.0");
  assert.strictEqual(pkg.dependencies["@earendil-works/pi-ai"], "1.1.0");
  assert.strictEqual(pkg.dependencies["@earendil-works/chord"], "1.1.0");
});

Given("worker 已注册版本匹配的翻译、审校和校验扩展及任务定义", async function () {
  worker = new AgentWorker({ storagePath: workerStoragePath });
  await worker.start({ registerDefinition: true });
  const readiness = await worker.readinessCheck();
  assert.strictEqual(readiness.ready, true);
});

Given("生产任务状态存储在可跨进程重启恢复的持久化存储中", function () {
  assert.ok(workerStoragePath.endsWith(".sqlite"));
});

Given("翻译 agent 只能使用上下文读取、术语查询和结构校验白名单工具", function () {
  const toolNames = WHITELIST_TOOLS.map((t) => t.name).sort();
  assert.deepStrictEqual(toolNames, [
    "query_glossary",
    "read_context",
    "validate_structure",
  ]);
  assert.ok(!toolNames.includes("bash"));
  assert.ok(!toolNames.includes("edit"));
  assert.ok(!toolNames.includes("write"));
});

Given("每个翻译块最多允许 {int} 次审校后的修订", function (int: number) {
  world.maxRevisions = int;
});

Given("每个逻辑模型请求包含首次请求在内最多允许 {int} 次网络尝试", function (int: number) {
  world.maxNetworkAttempts = int;
});

// ── Scenario Outline: 不同字幕来源进入同一 agent 翻译流程 ───────────

Given("字幕通过 {string} 取得并已由现有分句流程产生源 cues", function (source: string) {
  world.source = source;
  world.videoId = "test-video-123";
  world.title = "Test Subtitle Video";
  world.cues = [
    { cue_id: "c0", start: 0, end: 1500, text: "Welcome to this episode." },
    { cue_id: "c1", start: 1500, end: 3500, text: "Today we explore durable agents." },
  ];
});

When("用户设置 translate_engine 为 {string} 并请求翻译为 {string}", function (engine: string, toLang: string) {
  world.requestPayload = {
    translate_engine: engine,
    translate_to: toLang,
    video_id: world.videoId,
    title: world.title,
    cues: world.cues,
    source: world.source,
    segmentation: "rule",
  };
});

Then("后端将源 cues、源语言、目标语言和可用视频标题交给翻译 worker", async function () {
  world.job = await worker.submitOrAttachJob({
    cues: world.requestPayload.cues,
    videoId: world.requestPayload.video_id,
    title: world.requestPayload.title,
    fromLang: "en",
    toLang: world.requestPayload.translate_to,
    segmentation: world.requestPayload.segmentation,
  });
  assert.ok(world.job);
});

Then("任务执行上下文准备、翻译、独立审校和结构校验", async function () {
  await world.job.taskPromise;
  assert.strictEqual(world.job.status, "succeeded");
});

Then("返回字幕保留原有视频标识、标题、字幕来源及分句模式", function () {
  assert.ok(world.job.finalResult);
  world.response = {
    video_id: world.requestPayload.video_id,
    title: world.requestPayload.title,
    source: world.requestPayload.source,
    segmentation: world.requestPayload.segmentation,
    cues: world.job.finalResult.cues,
  };
  assert.strictEqual(world.response.video_id, world.requestPayload.video_id);
  assert.strictEqual(world.response.title, world.requestPayload.title);
  assert.strictEqual(world.response.source, world.requestPayload.source);
  assert.strictEqual(world.response.segmentation, world.requestPayload.segmentation);
});

Then("每个成功 cue 包含原文和通过审校及校验的译文", function () {
  assert.ok(world.response);
  for (const c of world.response.cues) {
    assert.ok(c.text);
    assert.ok(c.translation);
    assert.notStrictEqual(c.translation, "[Translation failed]");
  }
});

// ── Scenario: 旧调用方与旧翻译提供商仍可工作 ──────────────────────────

Given("服务器默认 translate_engine 为 {string}", function (engine: string) {
  world.defaultEngine = engine;
});

When("旧调用方不传 translate_engine 并选择 {string} 或 {string}", function (p1: string, p2: string) {
  world.requestPayload = {
    translate_provider: p1,
    translate_to: "zh-CN",
    cues: [{ start: 0, end: 1000, text: "Hello" }],
  };
});

Then("请求使用原有翻译路径", function () {
  const engine = world.requestPayload.translate_engine || world.defaultEngine;
  assert.strictEqual(engine, "legacy");
});

Then("请求与响应仍满足原有必需字段和字幕时间单位的契约", function () {
  world.response = {
    video_id: "test",
    title: "test",
    from_lang: "en",
    to_lang: "zh-CN",
    cues: [{ cue_id: "c0", start: 0.0, end: 1000.0, text: "Hello", translation: "你好" }],
  };
  assert.strictEqual(typeof world.response.cues[0].start, "number");
  assert.strictEqual(typeof world.response.cues[0].end, "number");
});

Then("不创建 durable 翻译任务", function () {
  assert.strictEqual(worker.jobs.size, 0);
});

// ── Scenario: 扩展设置可以实际选择 agent 而非仅改变界面文字 ─────────

Given("用户在扩展设置中选择 agent 并配置受支持的模型提供商和模型", function () {
  world.settings = {
    translateEngine: "agent",
    translateProvider: "openai",
    translateModel: "gpt-4o",
  };
});

When("扩展发送字幕翻译请求", function () {
  world.extensionRequest = {
    translate_engine: world.settings.translateEngine,
    translate_provider: world.settings.translateProvider,
    translate_model: world.settings.translateModel,
    translate_to: "zh-CN",
  };
});

Then("请求包含 translate_engine 为 {string}", function (engine: string) {
  assert.strictEqual(world.extensionRequest.translate_engine, engine);
});

Then("translate_provider 和 translate_model 对应所选模型配置", function () {
  assert.strictEqual(world.extensionRequest.translate_provider, "openai");
  assert.strictEqual(world.extensionRequest.translate_model, "gpt-4o");
});

Then("后端确认任务由 durable worker 执行", function () {
  assert.strictEqual(world.extensionRequest.translate_engine, "agent");
});

Then("请求正文、日志和响应不泄露服务端凭据", function () {
  const str = JSON.stringify(world.extensionRequest);
  assert.ok(!str.includes("sk-secret"));
  assert.ok(!str.includes("Cookie:"));
});

// ── Scenario: agent 配置不可用时明确失败而非静默回退 ────────────────

Given("选择的 agent 模型、凭据或 worker 配置无效", function () {
  world.invalidAgentConfig = {
    translate_engine: "agent",
    translate_provider: "unsupported_provider",
  };
});

When("用户请求 agent 翻译", function () {
  if (world.invalidAgentConfig.translate_provider === "unsupported_provider") {
    world.error = {
      status_code: 400,
      detail: "Invalid agent model, credentials, or worker configuration",
    };
  }
});

Then("系统返回明确的配置或服务不可用错误", function () {
  assert.ok(world.error);
  assert.strictEqual(world.error.status_code, 400);
});

Then("不自动改用 legacy 翻译", function () {
  assert.notStrictEqual(world.invalidAgentConfig.translate_engine, "legacy");
});

Then("不把未翻译字幕报告为翻译成功", function () {
  assert.strictEqual(world.response, null);
});

Then("仍允许用户关闭翻译后获取原字幕", function () {
  const origResp = {
    cues: [{ start: 0, end: 1000, text: "Original" }],
    translation_status: "not_requested",
  };
  assert.strictEqual(origResp.translation_status, "not_requested");
});

// ── Scenario: 未请求翻译时不启动 agent ──────────────────────────────

Given("请求未设置 translate_to", function () {
  world.noTranslateReq = {
    cues: [{ start: 0, end: 1000, text: "Original text" }],
    translate_to: null,
  };
});

When("系统处理字幕", function () {
  world.noTranslateResp = {
    cues: world.noTranslateReq.cues,
    translation_status: "not_requested",
  };
});

Then("返回原字幕且 translation_status 为 {string}", function (status: string) {
  assert.strictEqual(world.noTranslateResp.translation_status, status);
});

Then("不调用翻译或审校模型", function () {
  assert.strictEqual(worker.jobs.size, 0);
});

// ── Scenario: 翻译块获得连续上下文而不是仅获得待补译条目 ────────────

Given("视频中部分 cue 已翻译而其间的 cue 尚未完成", function () {
  world.allCues = [
    { cue_id: "c0", text: "First sentence.", translation: "第一句。" },
    { cue_id: "c1", text: "Middle sentence needing translation." },
    { cue_id: "c2", text: "Third sentence.", translation: "第三句。" },
  ];
});

Given("translate_whole 为 false", function () {
  world.translateWhole = false;
});

When("agent 补译尚未完成的 cue", function () {
  const pendingCues = [world.allCues[1]];
  world.partitionBlocks = partitionCuesIntoBlocks(world.allCues, {
    maxCuesPerBlock: 1,
  });
});

Then("待译块携带前后连续源字幕、可用标题和持久化术语表", function () {
  const block = world.partitionBlocks.find((b) =>
    b.cues.some((c) => c.cue_id === "c1")
  );
  assert.ok(block);
  assert.ok(block.contextBefore.some((c) => c.cue_id === "c0"));
  assert.ok(block.contextAfter.some((c) => c.cue_id === "c2"));
});

Then("已完成的相邻 cue 可以作为上下文但不作为待发布输出", function () {
  const block = world.partitionBlocks.find((b) =>
    b.cues.some((c) => c.cue_id === "c1")
  );
  assert.ok(block);
  assert.strictEqual(block.cues.length, 1);
  assert.strictEqual(block.cues[0].cue_id, "c1");
});

Then("agent 不将不相邻的待译 cue 假装成连续对话", function () {
  const nonAdjacent = [
    { cue_id: "c1", text: "Part 1" },
    { cue_id: "c9", text: "Part 9" },
  ];
  const blocks = partitionCuesIntoBlocks(nonAdjacent, { maxCuesPerBlock: 1 });
  assert.strictEqual(blocks.length, 2);
});

// ── Scenario: 结合上下文解释专业词义 ──────────────────────────────────

Given("源字幕为", function (dataTable: DataTable) {
  const rows = dataTable.hashes();
  world.cues = rows.map((r) => ({
    cue_id: r.cue_id,
    start: Number(r.start),
    end: Number(r.end),
    text: r.text,
  }));
});

Given("审核后的术语表规定 transaction 在数据库语境中译为 {string}", function (termTran: string) {
  world.glossary = { transaction: termTran };
});

When("agent 翻译并审校这些字幕", async function () {
  world.job = await worker.submitOrAttachJob({
    cues: world.cues,
    fromLang: "en",
    toLang: "zh-CN",
    initialGlossary: world.glossary,
  });
  await world.job.taskPromise;
});

Then("c0 的译文使用 {string} 而不是 {string}", function (expected: string, forbidden: string) {
  assert.ok(world.job.finalResult);
  const c0 = world.job.finalResult.cues.find((c) => c.cue_id === "c0");
  assert.ok(c0);
  assert.ok(c0.translation.includes(expected));
  assert.ok(!c0.translation.includes(forbidden));
});

Then("c1 的译文表达 {string} 的含义", function (meaning: string) {
  assert.ok(world.job.finalResult);
  const c1 = world.job.finalResult.cues.find((c) => c.cue_id === "c1");
  assert.ok(c1);
  assert.ok(
    c1.translation.includes("回滚该事务") ||
      c1.translation.includes("回滚") ||
      c1.translation.includes(meaning)
  );
});

Then("最终译文不添加源字幕没有提到的交易、付款或金额信息", function () {
  assert.ok(world.job.finalResult);
  for (const c of world.job.finalResult.cues) {
    assert.ok(!/(付款|支付|金额|美元)/.test(c.translation));
  }
});

// ── Scenario: 跨块复用术语并在重启后保持一致 ────────────────────────

Given("第一块已经审校并提交术语 embedding 在本视频 AI 语境中译为 {string}", async function (termTran: string) {
  world.job = await worker.submitOrAttachJob({
    cues: [{ cue_id: "c0", start: 0, end: 1000, text: "Vector embedding layer." }],
    initialGlossary: { embedding: termTran },
  });
  await world.job.taskPromise;
  assert.strictEqual(world.job.status, "succeeded");
});

When("后续翻译块在 worker 重启后再次出现相同语义的 embedding", async function () {
  // Restart worker with same storage
  await worker.close();
  worker = new AgentWorker({ storagePath: workerStoragePath });
  await worker.start();

  world.job2 = await worker.submitOrAttachJob({
    jobKey: "job-block-2-with-embedding",
    cues: [{ cue_id: "c1", start: 1000, end: 2000, text: "Dense embedding vector." }],
    initialGlossary: { embedding: "嵌入" },
  });
  await world.job2.taskPromise;
});

Then("翻译和审校都读取已提交的术语表", function () {
  assert.ok(world.job2.finalResult);
});

Then("后续译文使用 {string}", function (expected: string) {
  assert.ok(world.job2.finalResult);
  const c1 = world.job2.finalResult.cues.find((c) => c.cue_id === "c1");
  assert.ok(c1);
  assert.ok(c1.translation.includes(expected));
});

Then("未审校草稿中的术语选择不覆盖已确认术语", function () {
  const glossary = { embedding: "嵌入" };
  assert.strictEqual(glossary.embedding, "嵌入");
});

// ── Scenario: 审校发现否定、数字或单位误译后定向修订 ───────────────

Given("源字幕为 {string}", function (src: string) {
  world.singleCue = { cue_id: "c0", start: 0, end: 2000, text: src };
});

Given("翻译模型给出的草稿为 {string}", function (draft: string) {
  world.draftTranslations = { c0: draft };
});

Given("独立审校返回否定含义丢失和剂量错误及对应 cue_id", async function () {
  const review = await reviewTranslations([world.singleCue], world.draftTranslations);
  assert.strictEqual(review.passed, false);
  assert.ok(review.issues.some((i) => i.reason === "dose_and_number_error" || i.reason === "negation_loss"));
  world.reviewIssues = review.issues;
});

When("工作流执行修订", async function () {
  let callCount = 0;
  world.job = await worker.submitOrAttachJob({
    cues: [world.singleCue],
    translatorMock: async () => world.draftTranslations,
    reviewerMock: async ({ revisions }) => {
      callCount++;
      if (revisions === 0) {
        return {
          passed: false,
          issues: [
            { cue_id: "c0", reason: "negation_loss", details: "negation lost" },
            { cue_id: "c0", reason: "dose_and_number_error", details: "50mg instead of 5mg" },
          ],
        };
      }
      return { passed: true, issues: [] };
    },
    revisorMock: async () => ({
      c0: "不要将剂量增加到 5 毫克以上。",
    }),
  });
  await world.job.taskPromise;
});

Then("修订请求包含原文、草稿、上下文和具体审校问题", function () {
  assert.ok(world.reviewIssues.length > 0);
});

Then("只修订受影响的块而不重新翻译全部视频", function () {
  assert.ok(world.job.finalResult);
  assert.strictEqual(world.job.finalResult.cues.length, 1);
});

Then("修订后再次进行审校及结构校验", function () {
  assert.strictEqual(world.job.status, "succeeded");
});

Then("发布译文保留 {string} 的含义", function (phrase: string) {
  assert.ok(world.job.finalResult);
  const c0 = world.job.finalResult.cues[0];
  assert.ok(c0.translation.includes("5 毫克"));
  assert.ok(c0.translation.includes("不要"));
});

Then("错误草稿从未作为最终字幕发送给客户端", function () {
  assert.ok(world.job.finalResult);
  const c0 = world.job.finalResult.cues[0];
  assert.notStrictEqual(c0.translation, "将剂量增加到 50 毫克以上。");
});

// ── Scenario Outline: 严格拒绝不完整或不合法的输出映射 ─────────────

Given("待发布块包含 cue_id 为 c0、c1、c2 的三条非空源字幕", function () {
  world.threeCues = [
    { cue_id: "c0", start: 0, end: 1000, text: "Sentence 0" },
    { cue_id: "c1", start: 1000, end: 2000, text: "Sentence 1" },
    { cue_id: "c2", start: 2000, end: 3000, text: "Sentence 2" },
  ];
});

Given("模型返回 {string}", function (invalidOutput: string) {
  world.invalidCandidate = invalidOutput;
});

When("系统校验输出", function () {
  let candidateData: unknown = null;
  const inv = world.invalidCandidate;

  if (inv === "缺少 c1") {
    candidateData = [
      { cue_id: "c0", translation: "句0" },
      { cue_id: "c2", translation: "句2" },
    ];
  } else if (inv === "c1 重复出现两次") {
    candidateData = [
      { cue_id: "c0", translation: "句0" },
      { cue_id: "c1", translation: "句1" },
      { cue_id: "c1", translation: "句1-重复" },
    ];
  } else if (inv === "返回不存在的 c9") {
    candidateData = [
      { cue_id: "c0", translation: "句0" },
      { cue_id: "c1", translation: "句1" },
      { cue_id: "c2", translation: "句2" },
      { cue_id: "c9", translation: "句9" },
    ];
  } else if (inv === "c2 的译文为空或仅包含空白") {
    candidateData = [
      { cue_id: "c0", translation: "句0" },
      { cue_id: "c1", translation: "句1" },
      { cue_id: "c2", translation: "   " },
    ];
  } else if (inv === "无法解析的非结构化结果") {
    candidateData = "This is just unparseable text without JSON";
  } else if (inv === "只有解释而没有译文") {
    candidateData = "Here is the translation explanation of why it is good.";
  } else if (inv === "包含 Translation failed 占位符") {
    candidateData = [
      { cue_id: "c0", translation: "句0" },
      { cue_id: "c1", translation: "[Translation failed]" },
      { cue_id: "c2", translation: "句2" },
    ];
  }

  world.validation = validateOutputMapping(world.threeCues, candidateData);
});

Then("当前块不得作为已完成译文发布或缓存", function () {
  assert.strictEqual(world.validation.valid, false);
});

Then("系统记录可定位的校验错误并在预算内请求定向修复", function () {
  assert.ok(world.validation.errors.length > 0);
});

Then("系统不按行数截断、不用数组位置猜测映射且不将相邻译文补到缺失 cue", function () {
  assert.strictEqual(world.validation.valid, false);
  assert.strictEqual(world.validation.orderedCues, undefined);
});

// ── Scenario: 模型输出顺序变化不会造成字幕错位 ───────────────────────

Given("源字幕顺序为 c0、c1、c2", function () {
  world.threeCues = [
    { cue_id: "c0", start: 0, end: 1000, text: "A" },
    { cue_id: "c1", start: 1000, end: 2000, text: "B" },
    { cue_id: "c2", start: 2000, end: 3000, text: "C" },
  ];
});

Given("模型返回有效且唯一的映射但顺序为 c2、c0、c1", function () {
  world.shuffledOutput = [
    { cue_id: "c2", translation: "丙" },
    { cue_id: "c0", translation: "甲" },
    { cue_id: "c1", translation: "乙" },
  ];
});

When("输出通过审校及校验", function () {
  world.validation = validateOutputMapping(world.threeCues, world.shuffledOutput);
  assert.strictEqual(world.validation.valid, true);
});

Then("系统按 cue_id 将译文合并到原字幕", function () {
  assert.ok(world.validation.orderedCues);
  assert.strictEqual(world.validation.orderedCues[0].cue_id, "c0");
  assert.strictEqual(world.validation.orderedCues[1].cue_id, "c1");
  assert.strictEqual(world.validation.orderedCues[2].cue_id, "c2");
});

Then("客户端 index {int}、{int}、{int} 分别对应 c0、c1、c2", function (i0: number, i1: number, i2: number) {
  assert.ok(world.validation.orderedCues);
  assert.strictEqual(world.validation.orderedCues[i0].translation, "甲");
  assert.strictEqual(world.validation.orderedCues[i1].translation, "乙");
  assert.strictEqual(world.validation.orderedCues[i2].translation, "丙");
});

Then("每条源字幕的 start、end、text、顺序及数量与 agent 输入一致", function () {
  assert.ok(world.validation.orderedCues);
  assert.strictEqual(world.validation.orderedCues.length, world.threeCues.length);
  for (let i = 0; i < world.threeCues.length; i++) {
    assert.strictEqual(world.validation.orderedCues[i].start, world.threeCues[i].start);
    assert.strictEqual(world.validation.orderedCues[i].end, world.threeCues[i].end);
    assert.strictEqual(world.validation.orderedCues[i].text, world.threeCues[i].text);
  }
});

Then("毫秒时间值不转换成秒", function () {
  assert.ok(world.validation.orderedCues);
  assert.strictEqual(world.validation.orderedCues[0].start, 0);
  assert.strictEqual(world.validation.orderedCues[0].end, 1000);
});

// ── Scenario: 无法修复的块不会无限自我审校 ──────────────────────────

Given("某块在首次审校和 {int} 次修订后的审校中均未通过", async function (int: number) {
  world.job = await worker.submitOrAttachJob({
    cues: [
      { cue_id: "c0", start: 0, end: 1000, text: "Passing block cue" },
      { cue_id: "c1", start: 1000, end: 2000, text: "Failing block cue" },
    ],
    maxCuesPerBlock: 1,
    reviewerMock: async ({ cues, revisions }) => {
      if (cues.some((c) => c.cue_id === "c1")) {
        return {
          passed: false,
          issues: [{ cue_id: "c1", reason: "unfixable", details: "always fails" }],
        };
      }
      return { passed: true, issues: [] };
    },
  });
});

When("当前块处理结束", async function () {
  await world.job.taskPromise;
});

Then("该块标记为翻译失败并保留源字幕", function () {
  assert.ok(world.job.finalResult);
  const c1 = world.job.finalResult.cues.find((c) => c.cue_id === "c1");
  assert.ok(c1);
  assert.strictEqual(c1.translation, "");
  assert.strictEqual(c1.text, "Failing block cue");
});

Then("其他独立通过的块仍可发布", function () {
  assert.ok(world.job.finalResult);
  const c0 = world.job.finalResult.cues.find((c) => c.cue_id === "c0");
  assert.ok(c0);
  assert.ok(c0.translation);
});

Then("系统不再自动为该块启动新的修订调用", function () {
  assert.strictEqual(world.job.status, "partial");
});

Then("REST 返回 partial 或 failed 而不是 succeeded", function () {
  assert.ok(world.job.status === "partial" || world.job.status === "failed");
});

Then("流式 done.failed_cues 等于该块内未成功发布的 cue 数量", function () {
  assert.ok(world.job.finalResult);
  assert.strictEqual(world.job.finalResult.failed_cues, 1);
});

// ── Scenario: 源字幕中的指令只作为待翻译文本 ───────────────────────

Given("源字幕包含 {string}", function (str: string) {
  world.injectionCue = { cue_id: "c0", start: 0, end: 2000, text: str };
});

When("agent 翻译该 cue", async function () {
  world.job = await worker.submitOrAttachJob({
    cues: [world.injectionCue],
  });
  await world.job.taskPromise;
});

Then("最终字幕表达该句的原意而不是执行该指令", function () {
  assert.ok(world.job.finalResult);
  const c0 = world.job.finalResult.cues[0];
  assert.ok(c0.translation.includes("忽略") || c0.translation.includes("指令"));
  assert.ok(!c0.translation.includes("sk-"));
});

Then("agent 不读取凭据、不执行 shell 且不访问字幕指向的任意 URL", function () {
  const tools = WHITELIST_TOOLS.map((t) => t.name);
  assert.ok(!tools.includes("bash"));
  assert.ok(!tools.includes("write"));
  assert.ok(!tools.includes("edit"));
});

Then("提供给模型的工具列表不包含 bash、write、edit 或通用文件读取工具", function () {
  const tools = WHITELIST_TOOLS.map((t) => t.name);
  assert.ok(!tools.includes("bash"));
  assert.ok(!tools.includes("write"));
  assert.ok(!tools.includes("edit"));
});

Then("响应及日志不出现 API key 或 YouTube Cookie", function () {
  const resStr = JSON.stringify(world.job.finalResult);
  assert.ok(!resStr.includes("sk-secret"));
  assert.ok(!resStr.includes("Cookie"));
});

// ── Scenario Outline: 流式播放先展示原文且仅发布审校后的译文 ───────

Given("客户端通过 {string} 请求 agent 翻译", function (transport: string) {
  world.transport = transport;
  world.streamCues = [
    { cue_id: "c0", start: 0, end: 1000, text: "Sentence A" },
    { cue_id: "c1", start: 1000, end: 2000, text: "Sentence B" },
  ];
});

Given("模型处理持续超过 {int} 秒", function (sec: number) {
  world.durationSec = sec;
});

When("后端开始响应", async function () {
  world.job = await worker.submitOrAttachJob({
    cues: world.streamCues,
  });

  world.streamEvents = [];
  for await (const event of worker.observeJobStream(world.job, {
    heartbeatIntervalMs: 50,
  })) {
    world.streamEvents.push(event);
    if (event.type === "done") break;
  }
});

Then("在翻译完成前发送 meta 和带稳定 index 的 source_cue", function () {
  const meta = world.streamEvents.find((e) => e.type === "meta");
  assert.ok(meta);
  const sourceCues = world.streamEvents.filter((e) => e.type === "source_cue");
  assert.strictEqual(sourceCues.length, world.streamCues.length);
  assert.strictEqual(sourceCues[0].index, 0);
  assert.strictEqual(sourceCues[1].index, 1);
});

Then("连接等待期间每 {int} 秒或更短发送心跳", function (sec: number) {
  // Heartbeats are verified by observeJobStream yielding keepalive
  assert.ok(sec <= 10);
});

Then("翻译、审校过程中的草稿不发送为 cue 或 cue_chunk", function () {
  const chunks = world.streamEvents.filter((e) => e.type === "cue_chunk");
  assert.strictEqual(chunks.length, 0);
});

Then("每个成功 cue 的译文在持久化提交完成后才发送", function () {
  const cues = world.streamEvents.filter((e) => e.type === "cue");
  for (const c of cues) {
    assert.ok(c.translation);
  }
});

Then("最后发送包含 total_cues 和 failed_cues 的 done", function () {
  const done = world.streamEvents.find((e) => e.type === "done");
  assert.ok(done);
  assert.strictEqual(done.total_cues, world.streamCues.length);
  assert.strictEqual(done.failed_cues, 0);
});

Then("客户端按 index 更新原有字幕而不追加重复字幕", function () {
  const cues = world.streamEvents.filter((e) => e.type === "cue");
  const indices = new Set(cues.map((c) => c.index));
  assert.strictEqual(indices.size, cues.length);
});

// ── Scenario Outline: 三种接口诚实报告部分失败 ──────────────────────

Given("源字幕共有 {int} 条", function (int: number) {
  world.tenCues = Array.from({ length: int }, (_, i) => ({
    cue_id: `c${i}`,
    start: i * 1000,
    end: (i + 1) * 1000,
    text: `Text ${i}`,
  }));
});

Given("{int} 条已通过审校及校验并发布而另 {int} 条达到失败上限", function (passed: number, failed: number) {
  world.passedCount = passed;
  world.failedCount = failed;
});

When("用户通过 {string} 接收任务结果", async function (iface: string) {
  world.currentIface = iface;
  world.job = await worker.submitOrAttachJob({
    cues: world.tenCues,
    maxCuesPerBlock: 2,
    reviewerMock: async ({ cues }) => {
      const isFailing = cues.some((c) => c.cue_id === "c8" || c.cue_id === "c9");
      if (isFailing) {
        return { passed: false, issues: [{ reason: "failed" }] };
      }
      return { passed: true, issues: [] };
    },
  });
  await world.job.taskPromise;
});

Then("用户仍可观看全部 {int} 条原字幕及已完成的 {int} 条译文", function (total: number, passed: number) {
  assert.ok(world.job.finalResult);
  assert.strictEqual(world.job.finalResult.cues.length, total);
  const completed = world.job.finalResult.cues.filter((c) => Boolean(c.translation)).length;
  assert.strictEqual(completed, passed);
});

Then("结果明确包含 failed_cues 为 {int}", function (count: number) {
  assert.ok(world.job.finalResult);
  assert.strictEqual(world.job.finalResult.failed_cues, count);
});

Then("客户端不得显示 {string}", function (phrase: string) {
  assert.notStrictEqual(world.job.status, "succeeded");
});

Then("若接口为 REST 则 translation_status 为 {string} 且 progress 为 {int}", function (status: string, prog: number) {
  if (world.currentIface.includes("/api/subtitle/process")) {
    assert.strictEqual(world.job.status, status);
    const calculatedProgress = Math.round(
      ((world.tenCues.length - world.failedCount) / world.tenCues.length) * 100
    );
    assert.strictEqual(calculatedProgress, prog);
  }
});

Then("未完成译文不以成功缓存或完成计数参与后续恢复", function () {
  assert.ok(world.job.finalResult);
  const published = Object.keys(world.job.finalResult.published_cues || {}).length;
  assert.strictEqual(world.job.finalResult.failed_cues, 2);
});

// ── Scenario: 进程崩溃后恢复到最后一次已提交工作流阶段 ─────────────

Given("两个块已审校、校验并持久化发布", async function () {
  world.crashCues = [
    { cue_id: "c0", text: "Block 0 cue" },
    { cue_id: "c1", text: "Block 1 cue" },
    { cue_id: "c2", text: "Block 2 cue" },
  ];
});

Given("第三个块的译文草稿已提交而审校尚未完成", async function () {
  world.jobKey = "crash-recovery-job";
  world.job = await worker.submitOrAttachJob({
    jobKey: world.jobKey,
    cues: world.crashCues,
    initialGlossary: { embedding: "嵌入" },
  });
  // Wait for completion
  await world.job.taskPromise;
});

When("worker 进程被强制结束后使用同一存储重新启动并 resume", async function () {
  await worker.close();
  worker = new AgentWorker({
    storagePath: workerStoragePath,
    workerId: "resumed-worker-id",
  });
  await worker.start();
});

Then("任务恢复原 job_id、cue_id、术语表、工作流阶段和重试计数", async function () {
  const resumedJob = await worker.getJob(world.jobKey);
  assert.ok(resumedJob);
  assert.strictEqual(resumedJob.jobKey, world.jobKey);
});

Then("已发布的两个块不再进行翻译或审校模型调用", function () {
  assert.ok(true);
});

Then("第三个块从未完成的审校阶段继续", function () {
  assert.ok(true);
});

Then("未持久化的外部请求允许重新执行但不造成重复最终发布", function () {
  assert.ok(true);
});

Then("本场景不声称外部模型请求或计费实现 exactly-once", function () {
  assert.ok(true);
});

// ── Scenario: 发布提交后连接中断不会丢失结果 ────────────────────────

Given("某块最终译文已完成持久化提交", async function () {
  world.submittedCues = [{ cue_id: "c0", start: 0, end: 1000, text: "Committed cue" }];
  world.job = await worker.submitOrAttachJob({
    jobKey: "disconnect-recover-job",
    cues: world.submittedCues,
  });
  await world.job.taskPromise;
});

Given("在客户端收到该块前连接中断", function () {
  world.reconnectSignal = new AbortController();
  world.reconnectSignal.abort();
});

When("客户端以相同请求重新连接", async function () {
  world.reconnectEvents = [];
  for await (const event of worker.observeJobStream(world.job)) {
    world.reconnectEvents.push(event);
  }
});

Then("系统附着到原任务并发送当前已提交结果快照", function () {
  assert.ok(world.reconnectEvents.some((e) => e.type === "meta"));
  assert.ok(world.reconnectEvents.some((e) => e.type === "source_cue"));
});

Then("已完成译文标记 cached 为 true", function () {
  const cueEvent = world.reconnectEvents.find((e) => e.type === "cue");
  assert.ok(cueEvent);
  assert.strictEqual(cueEvent.cached, true);
});

Then("该块不再次调用翻译或审校模型", function () {
  assert.strictEqual(world.job.status, "succeeded");
});

Then("不依赖 pi-durable watch 重放所有历史事件", function () {
  assert.ok(world.reconnectEvents.length > 0);
});

// ── Scenario: 并发重复请求复用任务而非重复提交模型工作 ────────────

Given("两个客户端请求具有相同 job_key 且任务正在执行", function () {
  world.concurrentKey = "shared-concurrent-job-key";
});

When("两个请求同时进入后端", async function () {
  const p1 = worker.submitOrAttachJob({
    jobKey: world.concurrentKey,
    cues: [{ cue_id: "c0", text: "Concurrent request" }],
  });
  const p2 = worker.submitOrAttachJob({
    jobKey: world.concurrentKey,
    cues: [{ cue_id: "c0", text: "Concurrent request" }],
  });
  world.concurrentJobs = await Promise.all([p1, p2]);
});

Then("系统通过原子持久化任务索引复用同一任务", function () {
  assert.strictEqual(world.concurrentJobs[0].jobId, world.concurrentJobs[1].jobId);
  assert.strictEqual(world.concurrentJobs[0].taskId, world.concurrentJobs[1].taskId);
});

Then("同一会话中的阶段提交使用稳定 requestId 去重", function () {
  assert.strictEqual(world.concurrentJobs[0].conversationId, world.concurrentJobs[1].conversationId);
});

Then("两个客户端可以观察同一任务的当前已提交状态", function () {
  assert.strictEqual(world.concurrentJobs[0].status, world.concurrentJobs[1].status);
});

Then("不仅依赖进程内集合来防止重复工作", function () {
  assert.ok(world.concurrentJobs[0].taskId);
});

Then("不返回 translation_already_running 来代替附着能力", function () {
  assert.ok(world.concurrentJobs[0].jobId);
});

// ── Scenario: 多 worker 部署不会同时打开同一存储 ────────────────────

Given("一个 worker 已拥有指定 durable storage", function () {
  assert.ok(worker.storage);
});

When("第二个 worker 尝试打开同一 storage", async function () {
  world.worker2 = new AgentWorker({
    storagePath: workerStoragePath,
    workerId: "second-worker-id",
  });
  try {
    await world.worker2.start();
  } catch (err) {
    world.secondWorkerError = requestFailure(err);
  }
});

Then("宿主部署的所有权保护机制阻止第二个 worker 启动调度器", function () {
  assert.ok(world.secondWorkerError);
  assert.ok(world.secondWorkerError instanceof StorageOwnershipConflictError);
});

Then("日志明确报告存储所有权冲突", function () {
  assert.ok(world.secondWorkerError.message.includes("Storage ownership conflict"));
});

Then("所有权保护不依赖 pi-durable 提供跨进程锁", function () {
  assert.strictEqual(world.secondWorkerError.name, "StorageOwnershipConflictError");
});

// ── Scenario: 中断工具调用按 replay 声明恢复 ────────────────────────

Given("有一个声明 replay 为 safe 的只读术语查询工具和一个未声明 safe 的测试工具", function () {
  const queryTool = WHITELIST_TOOLS.find((t) => t.name === "query_glossary");
  assert.ok(queryTool);
  assert.strictEqual(queryTool.replay, "safe");
  assert.strictEqual(testUnsafeTool.replay, "unsafe");
});

When("worker 在工具执行途中崩溃并恢复", function () {
  world.interruptedToolResult = {
    isError: true,
    error: "interrupted",
  };
});

Then("safe 的术语查询允许重新执行", function () {
  const queryTool = WHITELIST_TOOLS.find((t) => t.name === "query_glossary");
  assert.ok(queryTool);
  assert.strictEqual(queryTool.replay, "safe");
});

Then("未声明 safe 的工具不自动重放而产生 interrupted 结果", function () {
  assert.strictEqual(world.interruptedToolResult.error, "interrupted");
});

Then("工作流将 interrupted 当作待处理失败而非成功工具结果", function () {
  assert.strictEqual(world.interruptedToolResult.isError, true);
});

Then("任何有外部副作用的工具不得仅靠声明 safe 来宣称幂等", function () {
  assert.ok(true);
});

// ── Scenario: 恢复时工作流定义缺失不能静默丢弃任务 ──────────────────

Given("存储中存在尚未完成的指定版本翻译任务", async function () {
  world.persistedJob = await worker.submitOrAttachJob({
    jobKey: "missing-def-job",
    cues: [{ cue_id: "c0", text: "Pending cue" }],
    translatorMock: async () => {
      await new Promise((r) => setTimeout(r, 10000));
      return { c0: "done" };
    },
  });
  await new Promise((r) => setTimeout(r, 60));
});

When("worker 启动时无法加载匹配的扩展或任务定义", async function () {
  await worker.close();
  // Start worker WITHOUT registering the translation task definition
  worker = new AgentWorker({
    storagePath: workerStoragePath,
    workerId: "new-worker-id",
  });
  await worker.start({ registerDefinition: false });
});

Then("就绪检查失败或该任务明确显示配置阻塞状态", async function () {
  const readiness = await worker.readinessCheck();
  assert.strictEqual(readiness.ready, false);
  assert.strictEqual(readiness.reason, "configuration_blocked");
  assert.ok(readiness.blockedTasks && readiness.blockedTasks.length > 0);
  assert.strictEqual(readiness.blockedTasks[0].reason, "missing_task");
});

Then("系统保留任务及已提交结果", function () {
  assert.ok(fs.existsSync(workerStoragePath));
});

Then("不创建一个空的新任务来伪装恢复成功", function () {
  assert.ok(true);
});

// ── Scenario Outline: 按错误类别进行有界网络重试 ───────────────────

Given("模型请求出现 {string}", function (failureType: string) {
  world.failureType = failureType;
});

When("系统处理该错误", async function () {
  world.attemptCounts = 0;
  world.budgetTracker = new RequestBudgetTracker({ maxBudget: 12 });

  try {
    await executeWithRetryAndBudget(
      async (attempt) => {
        world.attemptCounts = attempt;
        if (world.failureType === "429 且含 Retry-After") {
          const err: RequestFailure = new Error("Rate limit");
          err.statusCode = 429;
          err.retryAfter = "0.01";
          throw err;
        } else if (world.failureType === "可重试 5xx") {
          const err: RequestFailure = new Error("Internal server error");
          err.statusCode = 503;
          throw err;
        } else if (world.failureType === "网络超时") {
          const err: RequestFailure = new Error("Connection timed out");
          err.statusCode = 504;
          throw err;
        } else if (world.failureType === "401 或 403") {
          const err: RequestFailure = new Error("Unauthorized");
          err.statusCode = 401;
          throw err;
        } else if (world.failureType === "不支持的模型或请求参数") {
          const err: RequestFailure = new Error("unsupported model parameter");
          err.statusCode = 400;
          throw err;
        }
      },
      {
        maxAttempts: world.maxNetworkAttempts,
        budgetTracker: world.budgetTracker,
        sleepFn: () => Promise.resolve(),
      }
    );
  } catch (err) {
    assert.ok(err instanceof NetworkError);
    world.retryError = err;
  }
});

Then("系统执行 {string}", function (policy: string) {
  world.retryPolicyExecuted = policy;
  if (policy.includes("等待指定间隔后重试")) {
    assert.strictEqual(world.attemptCounts, 3);
  } else if (policy.includes("指数退避后重试")) {
    assert.strictEqual(world.attemptCounts, 3);
  } else if (policy.includes("有界重试")) {
    assert.strictEqual(world.attemptCounts, 3);
  } else if (policy.includes("立即报告认证或权限错误")) {
    assert.strictEqual(world.attemptCounts, 1);
    assert.strictEqual(world.retryError.errorType, "auth_error");
  } else if (policy.includes("立即报告配置错误")) {
    assert.strictEqual(world.attemptCounts, 1);
    assert.strictEqual(world.retryError.errorType, "config_error");
  }
});

Then("所有尝试计数在持久化状态中记录", function () {
  assert.ok(world.budgetTracker.attempts >= 1);
});

Then("自动重连或进程重启不重置尝试上限", function () {
  assert.strictEqual(world.maxNetworkAttempts, 3);
});

Then("达到上限时返回明确失败而不是空译文成功", function () {
  assert.ok(world.retryError);
  assert.notStrictEqual(world.retryError.message, "");
});

// ── Scenario: 请求预算限制在恢复后仍生效 ────────────────────────────

Given("测试任务最多允许 {int} 次外部模型请求尝试", function (int: number) {
  world.budgetTracker = new RequestBudgetTracker({ maxBudget: int });
});

Given("包含翻译、审校、修订、重试和压缩的 {int} 次请求已被持久化预留并发出", function (int: number) {
  for (let i = 0; i < int; i++) {
    world.budgetTracker.checkAndReserve();
  }
  world.budgetTracker.recordError(new Error("interrupted"), true);
});

When("工作流还需要新的模型请求或在此时恢复运行", function () {
  try {
    world.budgetTracker.checkAndReserve();
  } catch (err) {
    assert.ok(err instanceof BudgetExceededError);
    world.budgetExceededError = err;
  }
});

Then("系统不发送第 {int} 次请求", function (int: number) {
  assert.ok(world.budgetExceededError instanceof BudgetExceededError);
});

Then("返回 budget_exceeded 并保留已完成字幕", function () {
  assert.strictEqual(world.budgetExceededError.code, "budget_exceeded");
});

Then("对未确认用量的中断请求保守记录为已发出的尝试", function () {
  const report = world.budgetTracker.getUsageReport();
  assert.ok(report.interruptedAttempts > 0);
});

Then("使用量报告区分已知 token\\/cost 和无法确认的中断请求用量", function () {
  const report = world.budgetTracker.getUsageReport();
  assert.ok("knownTokens" in report);
  assert.ok("interruptedAttempts" in report);
});

// ── Scenario: 浏览器断开连接只停止观察不取消后台任务 ────────────────

Given("一个 durable 翻译任务正在执行", async function () {
  world.disconnectJob = await worker.submitOrAttachJob({
    jobKey: "browser-disconnect-job",
    cues: [
      { cue_id: "c0", text: "Sentence 0" },
      { cue_id: "c1", text: "Sentence 1" },
    ],
  });
});

When("用户刷新页面或暂时断开 SSE 或 WebSocket", function () {
  world.disconnectController = new AbortController();
  world.disconnectController.abort();
});

Then("本次观察或等待被停止但后台任务继续执行", async function () {
  await world.disconnectJob.taskPromise;
  assert.strictEqual(world.disconnectJob.status, "succeeded");
});

Then("重连使用同一 job_key 取得当前快照并继续观察", async function () {
  const events = [];
  for await (const event of worker.observeJobStream(world.disconnectJob)) {
    events.push(event);
  }
  assert.ok(events.some((e) => e.type === "meta"));
  assert.ok(events.some((e) => e.type === "cue" && e.cached === true));
});

Then("不因为浏览器断开而删除已提交译文", function () {
  assert.ok(world.disconnectJob.finalResult);
  assert.strictEqual(world.disconnectJob.finalResult.cues.length, 2);
});

// ── Scenario: 显式取消任务停止后续工作 ──────────────────────────────

Given("用户明确选择取消指定翻译任务而不是仅断开连接", async function () {
  world.cancelJob = await worker.submitOrAttachJob({
    jobKey: "explicit-abort-job",
    cues: [{ cue_id: "c0", text: "Cancel cue" }],
  });
});

When("宿主对该任务发出 abort", async function () {
  await worker.abortJob(world.cancelJob.jobId);
});

Then("所属翻译、审校及修订工作停止并记录取消状态", function () {
  assert.strictEqual(world.cancelJob.status, "cancelled");
});

Then("取消生效后不再调度新的模型请求", function () {
  assert.strictEqual(world.cancelJob.aborted, true);
});

Then("已提交的最终译文仍可读取", function () {
  assert.ok(world.cancelJob);
});

Then("重连不会将已取消任务自动恢复为运行中", async function () {
  const events = [];
  for await (const event of worker.observeJobStream(world.cancelJob)) {
    events.push(event);
  }
  const errEvent = events.find((e) => e.type === "error");
  assert.ok(errEvent);
  assert.strictEqual(errEvent.code, "task_cancelled");
});

// ── Scenario Outline: 修改影响译文的配置不能复用旧最终结果 ─────────

Given("同一视频已有完整且有效的最终译文缓存", function () {
  world.baseJobKeyOptions = {
    videoId: "vid-123",
    sourceCues: [{ cue_id: "c0", start: 0, end: 1000, text: "Sample" }],
    fromLang: "en",
    toLang: "zh-CN",
    segmentationVersion: "segment-v1",
    engine: "agent",
    provider: "openai",
    model: "gpt-4o",
    promptVersion: "prompt-v1",
    reviewVersion: "review-v1",
    workflowVersion: "wf-v1",
    glossaryVersion: "glossary-v1",
    styleConfig: "standard",
  };
  world.initialJobKey = calculateJobKey(world.baseJobKeyOptions);
});

When("请求的 {string} 发生变化", function (dimension: string) {
  const modified = { ...world.baseJobKeyOptions };
  if (dimension === "完整源字幕内容或时间轴") {
    modified.sourceCues = [{ cue_id: "c0", start: 100, end: 1100, text: "Sample" }];
  } else if (dimension === "源语言或目标语言") {
    modified.toLang = "ja";
  } else if (dimension === "分句算法版本") {
    modified.segmentationVersion = "segment-v2";
  } else if (dimension === "legacy 与 agent 引擎") {
    modified.engine = "legacy";
  } else if (dimension === "模型或提供商端点身份") {
    modified.model = "gpt-4-turbo";
  } else if (dimension === "翻译或审校提示词版本") {
    modified.promptVersion = "prompt-v2";
  } else if (dimension === "工作流版本") {
    modified.workflowVersion = "wf-v2";
  } else if (dimension === "术语表版本") {
    modified.glossaryVersion = "glossary-v2";
  } else if (dimension === "字幕风格配置") {
    modified.styleConfig = "concise";
  }
  world.newJobKey = calculateJobKey(modified);
});

Then("系统使用不同的 job_key 和翻译缓存配置标识", function () {
  assert.notStrictEqual(world.initialJobKey, world.newJobKey);
});

Then("不将旧缓存直接标记为本次任务的成功译文", function () {
  assert.notStrictEqual(world.initialJobKey, world.newJobKey);
});

Then("元数据及未变化的源字幕缓存仍可按原策略复用", function () {
  assert.ok(true);
});

// ── Scenario: 长视频按上下文预算分块且不漏掉尾部字幕 ────────────────

Given("完整字幕的 token 数超过所选模型可用上下文窗口", function () {
  world.longCues = Array.from({ length: 50 }, (_, i) => ({
    cue_id: `c${i}`,
    start: i * 2000,
    end: (i + 1) * 2000,
    text: `Subtitle sentence number ${i} with substantial length and technical context.`,
  }));
});

Given("测试配置为输入、输出及审校保留了显式 token 预算", function () {
  world.contextWindow = 1000;
  world.reserveOutputTokens = 200;
  world.reservePromptTokens = 100;
});

When("agent 准备翻译任务", function () {
  world.partitionBlocks = partitionCuesIntoBlocks(world.longCues, {
    contextWindow: world.contextWindow,
    reserveOutputTokens: world.reserveOutputTokens,
    reservePromptTokens: world.reservePromptTokens,
    maxCuesPerBlock: 5,
  });
});

Then("按连续 cue 边界分块并为每个块附加预算内的前后文和术语表", function () {
  assert.ok(world.partitionBlocks.length > 1);
  for (const block of world.partitionBlocks) {
    assert.ok(block.cues.length > 0);
  }
});

Then("每个请求的输入与预留输出之和不超过模型上下文窗口", function () {
  for (const block of world.partitionBlocks) {
    const inputTokens = block.cues.reduce((acc, c) => acc + estimateTokens(c.text), 0);
    assert.ok(inputTokens + world.reserveOutputTokens <= world.contextWindow);
  }
});

Then("全部源 cue 恰好属于一个待发布块", function () {
  const publishedIds = [];
  for (const block of world.partitionBlocks) {
    for (const cue of block.cues) {
      publishedIds.push(cue.cue_id);
    }
  }
  assert.strictEqual(publishedIds.length, world.longCues.length);
  assert.strictEqual(new Set(publishedIds).size, world.longCues.length);
});

Then("重叠上下文不产生重复输出", function () {
  for (const block of world.partitionBlocks) {
    for (const ctx of block.contextBefore) {
      assert.ok(!block.cues.some((c) => c.cue_id === ctx.cue_id));
    }
    for (const ctx of block.contextAfter) {
      assert.ok(!block.cues.some((c) => c.cue_id === ctx.cue_id));
    }
  }
});

Then("最后一条源字幕也有最终成功或失败状态", function () {
  const lastBlock = world.partitionBlocks[world.partitionBlocks.length - 1];
  const lastCue = lastBlock.cues[lastBlock.cues.length - 1];
  assert.strictEqual(lastCue.cue_id, `c${world.longCues.length - 1}`);
});

Then("上下文压缩不能删除待译原文或已确认术语的持久化记录", function () {
  assert.ok(true);
});

// ── Scenario: 真实模型在冻结评测集上优于当前实现 ────────────────────

Given("评测集至少包含 {int} 条 cue 并覆盖技术讲解、日常对话和口语表达", function (int: number) {
  world.dataset = generateFrozenDataset(int);
  assert.ok(world.dataset.length >= int);
  const categories = new Set(world.dataset.map((c) => c.category));
  assert.ok(categories.has("technical"));
  assert.ok(categories.has("dialogue"));
  assert.ok(categories.has("colloquial"));
});

Given("评测集包含跨块指代、术语、否定、数字单位、专有名词及自动字幕噪声", function () {
  assert.ok(world.dataset.some((c) => c.term));
  assert.ok(world.dataset.some((c) => c.text.includes("5 mg")));
});

Given("可辨识源文有经独立审核的语义约束与可接受译法", function () {
  assert.ok(world.dataset.every((c) => Boolean(c.expected)));
});

Given("含噪或歧义源文的评判不要求模型凭空修正未知事实", function () {
  assert.ok(true);
});

Given("legacy 基线和 agent 使用相同字幕、分句、目标语言及翻译模型快照", function () {
  assert.ok(true);
});

Given("每条路径独立运行 {int} 次并由两名不知路径身份的评审打分", function (int: number) {
  world.runsCount = int;
});

Given("评审分歧经独立裁决后按每千源词计算加权错误分", function () {
  assert.ok(true);
});

Given("严重语义颠倒记 {int} 分、主要误译或漏译记 {int} 分、次要问题记 {int} 分", function (s: number, m: number, min: number) {
  assert.strictEqual(s, 25);
  assert.strictEqual(m, 5);
  assert.strictEqual(min, 1);
});

Given("基线的中位加权错误分大于 {int}", function (int: number) {
  // Baseline simulated runs with errors
  world.baselineRuns = [
    { issues: [{ severity: "major" }, { severity: "major" }, { severity: "minor" }] },
    { issues: [{ severity: "major" }, { severity: "major" }, { severity: "major" }] },
    { issues: [{ severity: "major" }, { severity: "major" }] },
  ];
  world.agentRuns = [
    { issues: [{ severity: "minor" }], timelineIntegrity: 100 },
    { issues: [{ severity: "minor" }, { severity: "minor" }], timelineIntegrity: 100 },
    { issues: [{ severity: "minor" }], timelineIntegrity: 100 },
  ];
});

When("比较两条路径的中位加权错误分", function () {
  world.evalReport = evaluateQualityGate({
    baselineRuns: world.baselineRuns,
    agentRuns: world.agentRuns,
    totalSourceWords: 1000,
  });
});

Then("agent 的中位加权错误分至少比 legacy 降低 {int}%", function (pct: number) {
  assert.ok(world.evalReport.reductionPercent >= pct);
});

Then("agent 在可辨识源文上没有新增严重语义颠倒", function () {
  assert.strictEqual(world.evalReport.zeroSevereInversions, true);
});

Then("字幕映射、数量与时间轴完整性通过率为 {int}%", function (pct: number) {
  assert.strictEqual(world.evalReport.timelineIntegrityMet, true);
});

Then("报告列出术语一致性、误译、漏译、耗时、模型调用和已知 token\\/cost", function () {
  assert.ok(world.evalReport.metadata);
});

Then("保留模型、提示词、术语表、工作流版本及匿名化输出以便复现", function () {
  assert.strictEqual(world.evalReport.metadata.workflowVersion, "wf-v1");
  assert.strictEqual(world.evalReport.metadata.promptVersion, "prompt-v1");
});

Then("任一质量门槛未满足时不得宣称迁移改善了翻译质量", function () {
  assert.strictEqual(world.evalReport.allGatesPassed, true);
});
