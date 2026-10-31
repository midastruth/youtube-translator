import type { ServerResponse } from "node:http";
import { endModelStream, modelChunk } from "./model-stream.js";

type Message = { role: string; name?: string; content?: string; tool_calls?: { function: { name: string; arguments: string } }[] };
export type AgentPayload = { tools?: { function: { name: string } }[]; messages: Message[] };
export function sendAgentTools(res: ServerResponse, tools: { name: string; args: unknown }[]) {
  modelChunk(res, { tool_calls: tools.map((tool, index) => ({ index, id: `tool-${index}`, type: "function", function: { name: tool.name, arguments: JSON.stringify(tool.args) } })) });
  endModelStream(res, "tool_calls");
}

/** Deterministic mock of main/child workspace sessions. No real model tokens. */
export function scriptedAgentTools(payload: AgentPayload, translate = (id: string) => `数据库事务：${id}`): { name: string; args: unknown }[] {
  const last = payload.messages.filter(m => m.role === "tool").at(-1);
  const main = payload.tools?.some(t => t.function.name === "dispatch_subagents");
  if (!last) return [{ name: "read_file", args: { path: "source.json", offset: 0, count: 100 } }];
  const assistant = payload.messages.filter(m => m.role === "assistant" && m.tool_calls?.length).at(-1)!;
  const call = assistant.tool_calls!.at(-1)!.function;
  const args = JSON.parse(call.arguments);
  const result = JSON.parse(last.content!);
  if (call.name === "read_file" && args.path === "source.json") {
    const source = JSON.parse(result.content) as { cue_id: string }[];
    if (main) {
      if (result.next_offset != null) return [{ name: "read_file", args: { path: "source.json", offset: result.next_offset, count: 100 } }];
      // Repeated pages (e.g. re-reading after compaction) must not duplicate cues in the plan.
      const all = [...new Map(payload.messages.filter(m => m.role === "tool").flatMap(m => {
        const r = JSON.parse(m.content!);
        return typeof r.content === "string" && r.content.startsWith("[") ? JSON.parse(r.content) as { cue_id: string }[] : [];
      }).map(c => [c.cue_id, c])).values()];
      const team = payload.messages.filter(m => m.role === "user").map(m => {
        try { return JSON.parse(m.content || "{}"); } catch { return {}; }
      }).find(m => m.role === "main");
      const openingSize = team?.stream_opening ? all.findIndex(c => c.cue_id === team.opening_target.suggested_end_id) + 1 : 0;
      const remainder = all.slice(openingSize);
      const count = remainder.length ? Math.min(9, Math.max(1, Math.ceil(remainder.length / 80))) : 0;
      const size = count ? Math.ceil(remainder.length / count) : 0;
      return [{ name: "dispatch_subagents", args: { brief: "Natural concise subtitles. transaction=数据库事务; preserve negation and numbers.",
        ...(openingSize ? { opening: { end_id: all[openingSize - 1].cue_id, instructions: "Translate the opening promptly for viewing." } } : {}),
        assignments: Array.from({ length: count }, (_, i) => ({ start_id: remainder[i * size].cue_id, end_id: remainder[Math.min(remainder.length, (i + 1) * size) - 1].cue_id, instructions: "Translate this semantic section using the shared glossary." })) } }];
    }
    return [{ name: "write_file", args: { path: "translations.json", merge: true, content: JSON.stringify(Object.fromEntries(source.map(c => [c.cue_id, translate(c.cue_id)]))) } }];
  }
  if (call.name === "dispatch_subagents") return [{ name: "read_file", args: { path: "translations.json", offset: 0, count: 100 } }];
  if (call.name === "accept_translation") return [{ name: "close_subagents", args: {} }];
  if (call.name === "close_subagents") return [{ name: "validate_translation", args: {} }];
  if (call.name === "write_file" || call.name === "edit_file") {
    const sourceResults = payload.messages.filter(m => m.role === "tool").map(m => JSON.parse(m.content!)).filter(r => typeof r.content === "string" && r.content.startsWith("["));
    const page = sourceResults.at(-1);
    if (page?.next_offset != null) return [{ name: "read_file", args: { path: "source.json", offset: page.next_offset, count: 100 } }];
    return [{ name: "read_file", args: { path: "translations.json", offset: 0, count: 100 } }];
  }
  if (call.name === "read_file" && args.path === "translations.json") {
    return result.next_offset == null
      ? main ? [
        { name: "accept_translation", args: { review: "Checked meaning, negation, timing boundaries and transaction terminology against source." } },
        { name: "close_subagents", args: {} }, { name: "validate_translation", args: {} }, { name: "finish_translation", args: {} },
      ] : [{ name: "validate_translation", args: {} }]
      : [{ name: "read_file", args: { path: "translations.json", offset: result.next_offset, count: 100 } }];
  }
  if (call.name === "validate_translation") return [{ name: "finish_translation", args: {} }];
  throw new Error(`Unexpected agent mock tool ${call.name}`);
}
export function respondAsSubtitleAgent(payload: AgentPayload, res: ServerResponse, translate?: (id: string) => string) {
  if (!payload.tools?.some(t => t.function.name === "write_file")) return false;
  sendAgentTools(res, scriptedAgentTools(payload, translate));
  return true;
}
