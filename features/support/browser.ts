import { JSDOM } from "jsdom";
import fs from "node:fs";
import type { ExtensionSettings, StreamRequest, SubtitleEvent, PlayerResponse } from "../../minimal-extension/src/types.js";

export const OLD_SETTINGS = {
  toLang: "zh-CN", segmentation: "rule", translateModel: "gpt-4o", translateBaseUrl: "https://model.invalid/v1",
  translateApiKey: "fixture-only-not-a-secret", positionY: 18,
};

export async function eventually(check: () => boolean, message = "browser condition", timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`Timed out: ${message}`);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

type Message = { action: string };
type VttResponse = { ok: boolean; count?: number; filename?: string; error?: string };
export type StreamCall = { url: string; body: StreamRequest; controller: ReadableStreamDefaultController<Uint8Array>; signal?: AbortSignal | null };

export class BrowserFixture {
  dom = new JSDOM(`<!doctype html><title>Fixture - YouTube</title><div id="movie_player" class="html5-video-player"><div class="html5-video-container"><video></video></div><div class="ytp-chrome-bottom"><div class="ytp-right-controls"></div></div></div>`, {
    url: "https://www.youtube.com/watch?v=fixture-video", runScripts: "outside-only", pretendToBeVisual: true,
  });
  settings: Partial<ExtensionSettings>;
  scriptDirectory: string;
  streams: StreamCall[] = [];
  requests: { url: string; init?: RequestInit }[] = [];
  downloads: { filename: string; blob: Blob }[] = [];
  messages: Message[] = [];
  details: unknown[] = [];
  response?: VttResponse;
  tracksStatus = 200;
  playerPayload = "";
  private blobs = new Map<string, Blob>();
  private optionPages: JSDOM[] = [];
  private contentListener?: (msg: Message, sender: object, send: (response: VttResponse) => void) => void;
  private actionListener?: (tab: { id?: number }) => void;
  private storageListeners: ((changes: { ytsSettings: { oldValue: Partial<ExtensionSettings>; newValue: Partial<ExtensionSettings> } }) => void)[] = [];

  constructor(settings: Partial<ExtensionSettings> = {}, scriptDirectory = "minimal-extension/public") {
    this.scriptDirectory = scriptDirectory;
    this.settings = { ...settings };
    const w = this.dom.window;
    const fixture = this;
    Object.defineProperties(w, {
      chrome: { value: this.chromeBoundary() },
      fetch: { writable: true, value: this.fetch.bind(this) },
      Response: { value: Response }, Request: { value: Request },
      TextDecoder: { value: TextDecoder }, TextEncoder: { value: TextEncoder },
      Blob: { value: Blob }, AbortController: { value: AbortController },
    });
    Object.defineProperties(w.URL, {
      createObjectURL: { value: (blob: Blob) => {
        const url = `blob:fixture-${this.blobs.size}`;
        this.blobs.set(url, blob); return url;
      } },
      revokeObjectURL: { value: (url: string) => this.blobs.delete(url) },
    });
    w.HTMLAnchorElement.prototype.click = function() {
      const blob = fixture.blobs.get(this.href);
      if (!blob) throw new Error("Missing download blob");
      fixture.downloads.push({ filename: this.download, blob });
    };
    w.addEventListener("yts-request-subtitles", event => this.details.push(event.detail));
    w.addEventListener("yts-browser-subtitles", event => this.details.push(event.detail));
    // Polling is a timer boundary; invoke the actual bridge's poll promptly.
    Object.defineProperty(w, "setInterval", { value: (callback: () => void) => w.setTimeout(callback, 1) });
  }

  private chromeBoundary() {
    return {
      storage: {
        local: {
          get: (_keys: string[], callback: (data: { ytsSettings: Partial<ExtensionSettings> }) => void) => callback({ ytsSettings: { ...this.settings } }),
          set: (data: { ytsSettings: Partial<ExtensionSettings> }, callback?: () => void) => {
            const oldValue = this.settings;
            this.settings = { ...data.ytsSettings };
            for (const listener of this.storageListeners) listener({ ytsSettings: { oldValue, newValue: this.settings } });
            callback?.();
          },
        },
        onChanged: { addListener: (listener: (changes: { ytsSettings: { oldValue: Partial<ExtensionSettings>; newValue: Partial<ExtensionSettings> } }) => void) => this.storageListeners.push(listener) },
      },
      runtime: { onMessage: { addListener: (listener: NonNullable<BrowserFixture["contentListener"]>) => { this.contentListener = listener; } } },
      tabs: {
        query: (_query: object, callback: (tabs: { id: number }[]) => void) => callback([{ id: 1 }]),
        sendMessage: (_id: number, message: Message, callback?: (response: VttResponse) => void) => {
          this.messages.push(message);
          this.contentListener?.(message, {}, response => { this.response = response; callback?.(response); });
        },
      },
      action: {
        onClicked: { addListener: (listener: (tab: { id?: number }) => void) => { this.actionListener = listener; } },
        setBadgeBackgroundColor: (_options: object) => {}, setBadgeText: (_options: object) => {},
      },
    };
  }

  private async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
    this.requests.push({ url, init });
    if (url.includes("/api/timedtext")) return new Response(this.playerPayload);
    if (url.includes("/api/subtitle/tracks")) return Response.json(this.tracksStatus === 200
      ? { tracks: [{ source: "manual", language: "en" }] } : { detail: "Backend 400" }, { status: this.tracksStatus });
    if (!url.endsWith("/api/subtitle/stream")) throw new Error(`Unexpected URL ${url}`);
    const body: StreamRequest = JSON.parse(String(init?.body));
    const stream = new ReadableStream<Uint8Array>({ start: controller => {
      this.streams.push({ url, body, controller, signal: init?.signal });
    } });
    // Deliberately allow late frames after abort to verify the generation guard.
    return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
  }

  execute(name: "background" | "bridge" | "content") {
    this.dom.window.eval(fs.readFileSync(`${this.scriptDirectory}/${name}.js`, "utf8"));
  }
  options() {
    const dom = new JSDOM(fs.readFileSync(`${this.scriptDirectory}/options.html`, "utf8"), { runScripts: "outside-only" });
    Object.defineProperty(dom.window, "chrome", { value: this.chromeBoundary() });
    dom.window.eval(fs.readFileSync(`${this.scriptDirectory}/options.js`, "utf8"));
    this.optionPages.push(dom);
    return dom.window.document;
  }
  toggle() {
    const button = this.dom.window.document.getElementById("yts-toggle");
    if (!button) throw new Error("Missing real content toggle");
    button.click();
  }
  isOff() { return this.dom.window.document.getElementById("yts-toggle")?.title === "开启字幕翻译"; }
  send(events: SubtitleEvent[], call = this.streams.at(-1)) {
    if (!call) throw new Error("No real stream request");
    for (const event of events) call.controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
  }
  finish(call = this.streams.at(-1)) { call?.controller.close(); }
  seek(ms: number) {
    const video = this.dom.window.document.querySelector("video")!;
    video.currentTime = ms / 1000;
    video.dispatchEvent(new this.dom.window.Event("timeupdate"));
  }
  navigate(id: string) {
    this.dom.reconfigure({ url: `https://www.youtube.com/watch?v=${id}` });
    this.dom.window.dispatchEvent(new this.dom.window.Event("yt-navigate-finish"));
  }
  setPlayerResponse(response: PlayerResponse) {
    const player = this.dom.window.document.getElementById("movie_player")!;
    player.getPlayerResponse = () => response;
  }
  clickAction() {
    if (!this.actionListener) throw new Error("Background action listener not installed");
    this.actionListener({ id: 1 });
  }
  close() {
    const toggle = this.dom.window.document.getElementById("yts-toggle");
    if (toggle?.title === "关闭字幕翻译") toggle.click();
    this.dom.window.close();
    for (const dom of this.optionPages) dom.window.close();
    for (const call of this.streams) { try { call.controller.close(); } catch {} }
  }
}
