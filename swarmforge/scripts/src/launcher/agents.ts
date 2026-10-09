// Agent launch commands, per-role instruction files, and codex trust (port of swarmforge.bb, part 2).

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { isBlank, sq } from "../core/text.ts";
import type { Ctx, RoleRow } from "./context.ts";

const apsToolPurpose: Record<string, string> = {
  "gherkin-parser": "APS parsing",
  "ir-dry-checker": "IR DRY",
  "gherkin-mutator": "Gherkin mutation",
};

const roleRequiredTools: Record<string, string[]> = {
  specifier: ["gherkin-parser", "ir-dry-checker"],
  coder: ["gherkin-parser"],
  refactorer: ["gherkin-parser"],
  hardender: ["gherkin-parser", "gherkin-mutator"],
  architect: ["gherkin-parser", "gherkin-mutator"],
  QA: ["gherkin-parser"],
};

function requireEnsureLines(tools: string[]): string {
  return tools
    .map(
      (tool) =>
        `- \`${tool}\` (${apsToolPurpose[tool]}): \`swarm_tool.sh require ${tool}\`\n` +
        `  If missing, run exactly: \`swarm_tool.sh ensure ${tool}\`\n`,
    )
    .join("");
}

function parseDryCheckLines(tools: string[]): string {
  return (
    (tools.includes("gherkin-parser") ? "- Parse with the two-arg form: `gherkin-parser <feature> ./tmp/<stem>.json`\n" : "") +
    (tools.includes("ir-dry-checker") ? "- Dry-check with the two-arg form: `ir-dry-checker <ir> ./tmp/<stem>.dry.json`\n" : "")
  );
}

export function toolStartupSection(role: string, lastRole: boolean): string {
  const tools = roleRequiredTools[role] ?? [];
  return (
    "## Tool Startup\n\n" +
    "- Do not search `$HOME` or run `find` for APS tools.\n" +
    requireEnsureLines(tools) +
    parseDryCheckLines(tools) +
    "- Write scratch files and handoff drafts in `./tmp/` in the assigned worktree.\n" +
    "- Do not use `/tmp` or `.swarmforge/handoffs/outbox/tmp/` as scratch.\n" +
    "- Receive with `ready_for_next.sh`. Send with `swarm_handoff.sh ./tmp/<draft>`.\n" +
    "- Do not search the tree or `$HOME` for those scripts.\n" +
    "- Do not invoke helpers as `./swarmforge/scripts/...`. They are already on PATH.\n" +
    "- Board cards live in `.swarmforge/board/tasks.tsv`. Use that card name as `task:`.\n" +
    "- Operator task documents live in `tasks/<task-name>.md`. Re-read that file as operator intent. The master agent commits it with the task's first git work.\n" +
    "- A retry audit may include remedial comments on named documents. Read those comments as findings.\n" +
    "- Do not search the worktree for `.swarmforge/board/tasks.tsv`. That file is on the project (master).\n" +
    "- Use TASK_NAME from `ready_for_next.sh` or the inbound `task:` header. For a batch, that name is the top item. The helper fills `task:` from the in-process batch, else the sender-lane card.\n" +
    "- Do not invent a name or hunt `sessions.tsv`.\n" +
    "- Constitution tools: `swarm_tool.sh require crap4clj` (also dry4clj, clj-mutate, cloverage, speclj, speclj-structure-check, APS, or the language table). If missing, `swarm_tool.sh ensure <tool>`. Do not invent project `bb` proxies.\n" +
    "- Run constitution tools one at a time. Worker-limited tools use `--max-workers 4` or `--workers 4`. Mutation is differential: no `--mutate-all`, no `--level full`.\n" +
    "- Do not clone those repos into `./tmp`.\n" +
    "- If merge_and_process.sh or ready_for_next reports a merge conflict, resolve the conflicted files, git add, and commit. Do not invent git merge. Parallel cards on one tree will conflict; that is expected.\n" +
    "- Operator follow-ups arrive as `[id] text` in this pane. Answer with `pack_dashboard_request.sh answer <id> ./tmp/answer.txt`.\n" +
    "- Ask the operator with `pack_dashboard_request.sh clarify ./tmp/question.txt`. Do not ask in the pane.\n" +
    "- Do not ask for approval in the pane. Queue `git_handoff`; the operator uses Attention.\n" +
    (lastRole
      ? "- You are the last role in this pack. After this pack step, queue a git_handoff. The helper marks the card Done. Do not list every other role on to: to finish the card.\n"
      : "") +
    (role === "specifier"
      ? "- Specify from the board card and the current product tree. Do not import behavior from sibling projects.\n" +
        "- Do not ask the operator what new feature to specify or what the card already states.\n" +
        "- Finish the assigned TASK_NAME and payload (the whole card), then one git_handoff. Do not hand off after the first feature in a folder.\n"
      : "") +
    (role === "QA" ? "- One commit is one git_handoff. Do not send two git_handoffs of the same SHA.\n" : "")
  );
}

export const lastPackRole = (ctx: Ctx, role: string): boolean => role !== "lieutenant" && role === ctx.roles.at(-1)?.role;

function writeAgentInstructionFile(ctx: Ctx, role: string, promptFile: string, lastRole: boolean): void {
  if (role === "lieutenant") {
    copyFileSync(join(ctx.rolesDir, "lieutenant.prompt"), promptFile);
    return;
  }
  writeFileSync(
    promptFile,
    "Read swarmforge/constitution.prompt, then read every file it refers to recursively, and obey all of those instructions.\n" +
      `Read swarmforge/roles/${role}.prompt, then read every file it refers to recursively, and follow all of those instructions.\n` +
      "\n" +
      toolStartupSection(role, lastRole),
  );
}

const extraArgsPrefix = (row: RoleRow): string => (isBlank(row.extraArgs) ? "" : `${row.extraArgs} `);
const extraHas = (row: RoleRow, needle: string): boolean => (row.extraArgs ?? "").includes(needle);

export function yoloFlag(agent: string, row: RoleRow): string {
  if (agent === "codex" || agent === "copilot") return extraHas(row, "--yolo") ? "" : "--yolo ";
  if (agent === "claude") return extraHas(row, "bypassPermissions") ? "" : "--permission-mode bypassPermissions ";
  return "";
}

const altScreenEnv = (agent: string, row: RoleRow): string =>
  agent === "claude" && !extraHas(row, "CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN") ? "CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1 " : "";

const noAltScreenFlag = (agent: string, row: RoleRow): string =>
  (agent === "codex" || agent === "copilot") && !extraHas(row, "--no-alt-screen") ? "--no-alt-screen " : "";

function claudeCommandLine(row: RoleRow, promptFile: string, initialPrompt: boolean): string {
  const prompt = `"$(cat ${sq(promptFile)})"`;
  return `${altScreenEnv("claude", row)}claude --append-system-prompt-file ${sq(promptFile)} ` +
    `${yoloFlag("claude", row)}-n ${sq(`SwarmForge ${row.displayName}`)} ${extraArgsPrefix(row)}${initialPrompt ? prompt : ""}`;
}

function codexCommandLine(row: RoleRow, promptFile: string, initialPrompt: boolean): string {
  const prompt = `"$(cat ${sq(promptFile)})"`;
  return `codex -C ${sq(row.worktreePath)} ${noAltScreenFlag("codex", row)}${yoloFlag("codex", row)}${extraArgsPrefix(row)}${initialPrompt ? prompt : ""}`;
}

function copilotCommandLine(row: RoleRow, promptFile: string, initialPrompt: boolean): string {
  const prompt = `"$(cat ${sq(promptFile)})"`;
  return `copilot -C ${sq(row.worktreePath)} ${noAltScreenFlag("copilot", row)}--name ${sq(`SwarmForge ${row.displayName}`)} ` +
    `${yoloFlag("copilot", row)}${extraArgsPrefix(row)}${initialPrompt ? `-i ${prompt}` : ""}`;
}

function grokCommandLine(row: RoleRow, promptFile: string, initialPrompt: boolean): string {
  const prompt = `"$(cat ${sq(promptFile)})"`;
  return `grok --cwd ${sq(row.worktreePath)} --permission-mode bypassPermissions ${extraArgsPrefix(row)}--minimal --rules ${prompt}` +
    (initialPrompt ? ` --verbatim ${prompt}` : "");
}

type AgentCmd = (row: RoleRow, promptFile: string, initialPrompt: boolean) => string;
const AGENT_COMMANDS: Record<string, AgentCmd> = {
  claude: claudeCommandLine,
  codex: codexCommandLine,
  copilot: copilotCommandLine,
  grok: grokCommandLine,
};

function cleanupSuffix(ctx: Ctx): string {
  return `; exit_code=$?; SWARMFORGE_TERMINAL_BACKEND=${sq(ctx.terminalBackend)}` +
    ` nohup ${sq(join(ctx.scriptDir, "swarm-cleanup.sh"))}` +
    ` ${sq(ctx.tmuxSocket)}` +
    ` ${sq(ctx.windowIdsFile)}` +
    ctx.roles.map((r) => ` ${sq(r.session)}`).join("") +
    " >/dev/null 2>&1 &!; exit $exit_code";
}

export function launchCommand(ctx: Ctx, index: number, row: RoleRow): string {
  const { role, agent, worktreePath } = row;
  const roleScriptDir = worktreePath === ctx.workingDir ? ctx.scriptDir : join(worktreePath, "swarmforge", "scripts");
  const promptFile = join(ctx.promptsDir, `${role}.md`);
  const toolBin = join(ctx.workingDir, ".swarmforge", "bin");
  const base =
    `export SWARMFORGE_ROLE=${sq(role)}` +
    ` && export PATH=${sq(toolBin)}:${sq(roleScriptDir)}:$PATH` +
    ` && cd ${sq(worktreePath)}` +
    " && ";
  writeAgentInstructionFile(ctx, role, promptFile, lastPackRole(ctx, role));
  const builder = AGENT_COMMANDS[agent];
  const command = builder ? builder(row, promptFile, role !== "lieutenant") : "";
  const full = base + command;
  return index === 0 ? full + cleanupSuffix(ctx) : full;
}
const codexHome = (): string => process.env.CODEX_HOME || join(homedir(), ".codex");
const projectTableHeader = (dir: string): string => `[projects.${JSON.stringify(resolve(dir))}]`;

function ensureNewline(text: string): string {
  if (isBlank(text)) return "";
  return text.endsWith("\n") ? text : `${text}\n`;
}

export function ensureCodexTrust(dir: string): void {
  if (isBlank(dir)) return;
  const home = codexHome();
  const cfg = join(home, "config.toml");
  const header = projectTableHeader(dir);
  const text = existsSync(cfg) ? readFileSync(cfg, "utf8") : "";
  if (text.includes(header)) return;
  mkdirSync(home, { recursive: true });
  writeFileSync(cfg, `${ensureNewline(text)}\n${header}\ntrust_level = "trusted"\n`);
}
