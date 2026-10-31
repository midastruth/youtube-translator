import type { ServerResponse } from "node:http";
import { endModelStream, modelChunk } from "./model-stream.js";

type Message = { role: string; name?: string; content?: string; tool_calls?: { function: { name: string; arguments: string } }[] };
export type AgentPayload = { tools?: { function: { name: string } }[]; messages: Message[] };
export function sendAgentTools(res: ServerResponse, tools: { name: string; args: unknown }[]) {
  modelChunk(res, { tool_calls: tools.map((tool, index) => ({ index, id: `tool-${index}`, type: "function", function: { name: tool.name, arguments: JSON.stringify(tool.args) } })) });
  endModelStream(res, "tool_calls");
}

/** Deterministic mock of a single agent choosing read/edit/check/submit tools. No real model tokens. */
export function scriptedAgentTools(payload: AgentPayload, translate = (id: string) => `数据库事务：${id}`): { name: string; args: unknown }[] {
  const last = payload.messages.filter(m => m.role === "tool").at(-1);
  if (!last) return [{ name: "read_file", args: { path: "source.json", offset: 0, count: 100 } }];
  const assistant = payload.messages.filter(m => m.role === "assistant" && m.tool_calls?.length).at(-1)!;
  const call = assistant.tool_calls!.at(-1)!.function;
  const args = JSON.parse(call.arguments);
  const result = JSON.parse(last.content!);
  if (call.name === "read_file" && args.path === "source.json") {
    const source = JSON.parse(result.content) as { cue_id: string }[];
    return [{ name: "write_file", args: { path: "translations.json", merge: true, content: JSON.stringify(Object.fromEntries(source.map(c => [c.cue_id, translate(c.cue_id)]))) } }];
  }
  if (call.name === "write_file" || call.name === "edit_file") {
    const sourceResults = payload.messages.filter(m => m.role === "tool").map(m => JSON.parse(m.content!)).filter(r => typeof r.content === "string" && r.content.startsWith("["));
    const page = sourceResults.at(-1);
    if (page?.next_offset != null) return [{ name: "read_file", args: { path: "source.json", offset: page.next_offset, count: 100 } }];
    return [{ name: "read_file", args: { path: "translations.json", offset: 0, count: 100 } }];
  }
  if (call.name === "read_file" && args.path === "translations.json") {
    return result.next_offset == null
      ? [{ name: "validate_translation", args: {} }]
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
