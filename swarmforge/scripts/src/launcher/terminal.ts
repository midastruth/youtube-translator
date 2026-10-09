// Bridge to the zsh terminal adapters (terminal-adapters/*.sh), which stay in shell.

import { join } from "node:path";
import { run, runOut, type RunResult } from "../core/proc.ts";
import { sq } from "../core/text.ts";

export interface TerminalContext {
  scriptDir: string;
  workingDir: string;
  tmuxSocket: string;
  terminalBackend: string;
}

export function normalizeTerminalBackend(backend: string): string {
  const b = backend.toLowerCase();
  if (["iterm", "iterm2", "iterm.app"].includes(b)) return "iterm2";
  if (["terminal", "terminal-app", "terminal.app"].includes(b)) return "terminal-app";
  if (["windows", "windows-terminal", "wt"].includes(b)) return "windows-terminal";
  if (["none", "current", "fallback"].includes(b)) return "none";
  return b;
}

export function adapterScript(ctx: TerminalContext, command: string, ...args: string[]): string[] {
  const script =
    `SCRIPT_DIR=${sq(ctx.scriptDir)}\n` +
    `WORKING_DIR=${sq(ctx.workingDir)}\n` +
    `TMUX_SOCKET=${sq(ctx.tmuxSocket)}\n` +
    `source ${sq(join(ctx.scriptDir, "swarm-terminal-adapter.sh"))}` +
    ` && load_terminal_backend ${sq(ctx.terminalBackend)}` +
    ` && ${command}` +
    args.map((arg) => ` ${sq(arg)}`).join("");
  return ["zsh", "-c", script];
}

export function terminalCall(ctx: TerminalContext, command: string, ...args: string[]): RunResult {
  const [cmd, ...rest] = adapterScript(ctx, command, ...args);
  return run(cmd!, rest);
}

export const terminalOk = (ctx: TerminalContext, command: string, ...args: string[]): boolean =>
  terminalCall(ctx, command, ...args).exit === 0;

export function terminalOut(ctx: TerminalContext, command: string, ...args: string[]): string {
  const [cmd, ...rest] = adapterScript(ctx, command, ...args);
  return runOut(cmd!, rest);
}
