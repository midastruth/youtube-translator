import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import type { SubtitleEvent } from "../../minimal-extension/src/types.js";
import { After, Given, When, Then } from "@cucumber/cucumber";
import { BrowserFixture, eventually, OLD_SETTINGS } from "../support/browser.js";
import { cleanProjectCopy, command, installLockedDependencies, succeeds } from "../support/project.js";

type Manifest = {
  background: { scripts: string[]; service_worker: string }; content_scripts: { js: string[]; run_at: string; world?: string }[];
  options_ui: { page: string }; icons: Record<string, string>; action: { default_icon: Record<string, string> };
};
let browser: BrowserFixture | undefined;
let copy = "";
let manifest: Manifest;
let optionsDocument: Document;
let expectedCue: { start: number; end: number; text: string; translation?: string };
let previousState = "";
let oldStream: BrowserFixture["streams"][number] | undefined;
let requestsBefore = 0;
let payload = "";
const jsonEvents = [{ tStartMs: 100, dDurationMs: 1000, segs: [{ utf8: "Hello", tOffsetMs: 125 }, { utf8: " world", tOffsetMs: 500 }] }];
const xmlCues = [{ start: 100, end: 1100, text: "Hello world" }];
let built = false;
function fixture() { assert.ok(browser); return browser; }
function publicDirectory() { return path.join(copy, "minimal-extension/public"); }
function input(document: Document, id: string) {
  const element = document.getElementById(id);
  assert.ok(element && "value" in element);
  return element as HTMLInputElement | HTMLSelectElement;
}
After(() => {
  browser?.close(); browser = undefined; oldStream = undefined;
  if (copy) fs.rmSync(copy, { recursive: true, force: true });
  copy = "";
});
Given("已按锁文件安装依赖并从 TS 源码构建扩展", () => {
  installLockedDependencies();
  if (!built) { succeeds(command(["npm", "run", "build:extension"])); built = true; }
});
Given("扩展测试使用受控播放器、浏览器 API 和后端响应边界", () => { browser = new BrowserFixture(); });
When("从不含生成 JS 的 checkout 运行 make build-extension", () => {
  copy = cleanProjectCopy();
  succeeds(command(["make", "build-extension"], copy));
  manifest = JSON.parse(fs.readFileSync(path.join(publicDirectory(), "manifest.json"), "utf8"));
});
Then(/^"([^"]+)" 的现有加载入口 "([^"]+)" 包含完整可加载扩展$/, (name: string, entry: string) => {
  assert.ok(fs.existsSync(path.join(copy, entry)));
  if (name.startsWith("Chrome")) assert.ok(manifest.background.service_worker);
  else assert.deepEqual(manifest.background.scripts, ["background.js"]);
  assert.equal(manifest.options_ui.page, "options.html");
});
Then("manifest 与 options.html 引用的全部 JS、HTML 和图标均存在", () => {
  const html = fs.readFileSync(path.join(publicDirectory(), manifest.options_ui.page), "utf8");
  const scripts = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map(match => match[1]);
  const files = [manifest.background.service_worker, ...manifest.background.scripts,
    ...manifest.content_scripts.flatMap(script => script.js), manifest.options_ui.page,
    ...Object.values(manifest.icons), ...Object.values(manifest.action.default_icon), ...scripts];
  for (const file of files) assert.ok(fs.existsSync(path.join(publicDirectory(), file)), file);
});
Then("background、bridge、content、options 的执行入口为生成的 JavaScript", () => {
  for (const name of ["background", "bridge", "content", "options"]) {
    assert.ok(fs.existsSync(path.join(copy, `minimal-extension/src/${name}.ts`)));
    assert.ok(fs.existsSync(path.join(publicDirectory(), `${name}.js`)));
    assert.equal(fs.existsSync(path.join(publicDirectory(), `${name}.ts`)), false);
  }
});
Then("脚本不残留 TS 语法、未解析的模块引用或 Node 专用 API", () => {
  for (const name of ["background", "bridge", "content", "options"] as const) {
    const source = fs.readFileSync(path.join(publicDirectory(), `${name}.js`), "utf8");
    new vm.Script(source); // Parse as real JavaScript, not TS.
    assert.doesNotMatch(source, /\brequire\s*\(/);
    assert.doesNotMatch(source, /node:|process\.env|Buffer\./);
    fixture().scriptDirectory = publicDirectory();
    if (name === "options") fixture().options();
    else fixture().execute(name);
  }
});
Then("bridge 仍在 document_start 的 MAIN world 加载且 content 仍在 document_end 加载", () => {
  const bridge = manifest.content_scripts.find(script => script.js.includes("bridge.js"));
  const content = manifest.content_scripts.find(script => script.js.includes("content.js"));
  assert.equal(bridge?.run_at, "document_start"); assert.equal(bridge?.world, "MAIN");
  assert.equal(content?.run_at, "document_end");
});
Given("chrome.storage.local 的 ytsSettings 已含 positionY 为 18 且含旧翻译配置", () => {
  fixture().settings = { ...OLD_SETTINGS };
});
When(/^在生成的设置页中将后端地址设为 "([^"]+)"、翻译引擎设为 "([^"]+)" 并保存$/, (backend: string, engine: string) => {
  optionsDocument = fixture().options();
  input(optionsDocument, "backendUrl").value = backend;
  input(optionsDocument, "translateEngine").value = engine;
  optionsDocument.getElementById("saveButton")!.click();
});
Then(/^ytsSettings 的 backendUrl 为 "([^"]+)" 且 translateEngine 为 "([^"]+)"$/, (backend: string, engine: string) => {
  assert.equal(fixture().settings.backendUrl, backend); assert.equal(fixture().settings.translateEngine, engine);
});
Then("positionY 仍为 18 且存储键未改名", () => {
  const settings = fixture().settings;
  assert.equal(settings.positionY, 18);
  for (const [key, value] of Object.entries(OLD_SETTINGS)) assert.equal(settings[key as keyof typeof OLD_SETTINGS], value);
});
Then("重载设置页仍显示保存值", () => {
  optionsDocument = fixture().options();
  assert.equal(input(optionsDocument, "backendUrl").value, fixture().settings.backendUrl);
  assert.equal(input(optionsDocument, "translateEngine").value, fixture().settings.translateEngine);
});
When("在生成的 content 脚本中开启当前视频翻译", async () => {
  fixture().execute("content"); fixture().toggle();
  await eventually(() => fixture().streams.length > 0);
});
Then(/^请求发往 "([^"]+)" 的 \/api\/subtitle\/stream$/, (base: string) => {
  assert.equal(fixture().streams[0].url, `${base}/api/subtitle/stream`);
});
Then(/^请求中的 translate_engine 为 "([^"]+)" 且 translate_to、segmentation、模型配置与已存设置一致$/, (engine: string) => {
  const request = fixture().streams[0].body;
  assert.equal(request.translate_engine, engine);
  assert.equal(request.translate_to, OLD_SETTINGS.toLang); assert.equal(request.segmentation, OLD_SETTINGS.segmentation);
  assert.equal(request.translate_model, OLD_SETTINGS.translateModel); assert.equal(request.translate_base_url, OLD_SETTINGS.translateBaseUrl);
  assert.equal(request.translate_api_key, OLD_SETTINGS.translateApiKey);
});
Given(/^当前视频已开启翻译且后端流包含 index 为 0 的原字幕 "([^"]+)"、start 为 (\d+)、end 为 (\d+)$/, async (text: string, start: string, end: string) => {
  expectedCue = { text, start: Number(start), end: Number(end) };
  fixture().execute("content"); fixture().toggle();
  await eventually(() => fixture().streams.length > 0);
});
When(/^真实 content 脚本依次接收 source_cue、译文为 "([^"]+)" 的 cue、同一 cue 的重复事件和成功 done$/, async (translation: string) => {
  expectedCue.translation = translation;
  const cue = { index: 0, ...expectedCue };
  fixture().send([{ type: "meta", total_cues: 1, completed_cues: 0, failed_cues: 0 }, { type: "source_cue", ...cue, translation: undefined },
    { type: "cue", ...cue }, { type: "cue", ...cue }, { type: "done", total_cues: 1, failed_cues: 0 }]);
  fixture().finish();
  await eventually(() => fixture().dom.window.document.querySelector(".status")?.textContent?.includes("字幕翻译完成") === true);
});
Then(/^播放时间位于该字幕区间时只显示一条原文 "([^"]+)" 和一条译文 "([^"]+)"$/, async (text: string, translation: string) => {
  fixture().seek((expectedCue.start + expectedCue.end) / 2);
  await eventually(() => fixture().dom.window.document.querySelector(".tran")?.textContent === translation);
  const document = fixture().dom.window.document;
  assert.equal(document.querySelectorAll(".orig").length, 1); assert.equal(document.querySelectorAll(".tran").length, 1);
  assert.equal(document.querySelector(".orig")?.textContent, text);
  assert.equal(document.querySelector<HTMLElement>(".bg")?.style.display, "block");
});
When("通过生成的 background 脚本点击扩展图标发送 downloadVtt 消息", () => {
  fixture().execute("background"); fixture().clickAction();
  const message = fixture().messages.at(-1); assert.ok(message);
  assert.equal(message.action, "downloadVtt");
  assert.deepEqual(Object.keys(message), ["action"]);
});
Then("content 脚本返回 ok 为 true 且 count 为 1", () => {
  assert.equal(fixture().response?.ok, true); assert.equal(fixture().response?.count, 1);
});
Then(/^下载文件为 WebVTT 且包含 "([^"]+)"、原文 "([^"]+)" 和译文 "([^"]+)"$/, async (time: string, text: string, translation: string) => {
  assert.equal(fixture().downloads.length, 1);
  const file = fixture().downloads[0];
  assert.match(file.filename, /\.vtt$/);
  const contents = await file.blob.text();
  assert.ok(contents.startsWith("WEBVTT\n")); assert.ok(contents.includes(`${time}\n${text}\n${translation}`));
});
Given("存储中残留 enabled 为 true 的旧设置", () => { fixture().settings = { enabled: true }; });
Given(/^页面在事件前的状态为 "([^"]+)"$/, async (state: string) => {
  previousState = state;
  if (state === "已开启且有字幕") {
    fixture().execute("content"); fixture().toggle();
    await eventually(() => fixture().streams.length === 1);
    oldStream = fixture().streams[0];
    fixture().send([{ type: "meta", total_cues: 1 }, { type: "source_cue", index: 0, start: 0, end: 2000, text: "old source" },
      { type: "cue", index: 0, start: 0, end: 2000, text: "old source", translation: "旧字幕" }]);
    fixture().seek(100);
    await eventually(() => fixture().dom.window.document.querySelector(".tran")?.textContent === "旧字幕");
  } else assert.equal(state, "尚未加载脚本");
  requestsBefore = fixture().requests.length;
});
When(/^生成的 content 脚本经历 "([^"]+)"$/, (event: string) => {
  if (event === "首次加载视频页面") { assert.equal(previousState, "尚未加载脚本"); fixture().execute("content"); }
  else { assert.equal(event, "yt-navigate-finish"); fixture().navigate("new-video"); }
});
Then("当前视频的翻译开关为关闭且不自动请求后端字幕", () => {
  assert.equal(fixture().isOff(), true); assert.equal(fixture().requests.length, requestsBefore);
});
Then("页面不显示上一视频的字幕且忽略上一请求迟到的事件", async () => {
  if (oldStream) {
    fixture().send([{ type: "cue", index: 0, start: 0, end: 2000, text: "late", translation: "迟到" }, { type: "done", total_cues: 1, failed_cues: 0 }], oldStream);
    fixture().finish(oldStream);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(fixture().dom.window.document.querySelector<HTMLElement>(".bg")?.style.display, "none");
  } else assert.equal(fixture().dom.window.document.querySelector(".orig"), null);
  assert.equal(fixture().requests.length, requestsBefore);
});
Then("用户手动开启后才发送当前视频的请求", async () => {
  const before = fixture().streams.length;
  fixture().toggle(); await eventually(() => fixture().streams.length > before);
  const request = fixture().streams.at(-1)!;
  assert.equal(new URL(request.body.url).searchParams.get("v"), oldStream ? "new-video" : "fixture-video");
});
Given(/^后端轨道接口响应 400 且当前视频的播放器提供 "([^"]+)" 字幕$/, (value: string) => {
  payload = value; fixture().tracksStatus = 400;
  fixture().playerPayload = value === "json3" ? JSON.stringify({ events: jsonEvents })
    : '<transcript><text start="0.1" dur="1">Hello world</text></transcript>';
  fixture().setPlayerResponse({ videoDetails: { videoId: "fixture-video" }, captions: { playerCaptionsTracklistRenderer: {
    captionTracks: [{ baseUrl: "https://www.youtube.com/api/timedtext?v=fixture-video&lang=en", languageCode: "en" }],
  } } });
});
When("生成的 bridge 和 content 脚本处理当前视频的字幕兜底", async () => {
  fixture().execute("bridge"); fixture().execute("content"); fixture().toggle();
  await eventually(() => fixture().streams.length > 0);
});
Then("yts-request-subtitles 与 yts-browser-subtitles 仍通过 JSON 字符串 detail 跨 world 通信", () => {
  assert.ok(fixture().details.length >= 2);
  for (const detail of fixture().details) { assert.equal(typeof detail, "string"); assert.doesNotThrow(() => JSON.parse(String(detail))); }
});
Then(/^\/api\/subtitle\/stream 请求包含 "([^"]+)" 且字幕正文与播放器来源一致$/, (field: string) => {
  const body = fixture().streams[0].body;
  assert.deepEqual(field === "source_events" ? body.source_events : body.source_cues, payload === "json3" ? jsonEvents : xmlCues);
});
Then("请求的 source_video_id、source_language 与当前视频字幕一致", () => {
  const body = fixture().streams[0].body;
  assert.equal(body.source_video_id, "fixture-video"); assert.equal(body.source_language, "en");
});
Then("json3 逐词偏移或源 cue 毫秒时间轴不被迁移改变", () => {
  const body = fixture().streams[0].body;
  if (payload === "json3") assert.deepEqual(body.source_events, jsonEvents);
  else assert.deepEqual(body.source_cues, xmlCues);
});
Then("请求不包含浏览器 Cookie", () => {
  const request = fixture().requests.find(request => request.url.endsWith("/api/subtitle/stream")); assert.ok(request);
  assert.equal(new Headers(request.init?.headers).has("Cookie"), false);
  assert.doesNotMatch(String(request.init?.body), /cookie/i);
});
