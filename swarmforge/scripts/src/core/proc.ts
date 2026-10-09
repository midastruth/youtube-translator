import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, openSync, closeSync } from "node:fs";
import { dirname } from "node:path";

export interface RunResult {
  exit: number;
  out: string;
  err: string;
  /** Set when the command could not be started at all (e.g. ENOENT). */
  error?: Error;
}

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
}

/** Run a command to completion, never throwing on a non-zero exit (like `sh` / `{:continue true}`). */
export function run(command: string, args: readonly string[], options: RunOptions = {}): RunResult {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    input: options.input,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) {
    return { exit: 127, out: "", err: result.error.message, error: result.error };
  }
  return { exit: result.status ?? 1, out: result.stdout ?? "", err: result.stderr ?? "" };
}

/** Run and return trimmed stdout, or throw with stderr on failure. */
export function runOut(command: string, args: readonly string[], options: RunOptions = {}): string {
  const result = run(command, args, options);
  if (result.exit !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed (${result.exit}): ${result.err.trim()}`);
  }
  return result.out.trim();
}

export function commandExists(command: string): boolean {
  return run("sh", ["-c", 'command -v "$1" >/dev/null 2>&1', "sh", command]).exit === 0;
}

/** Run an interactive command on the current terminal, throwing on failure. */
export function runInteractive(command: string, args: readonly string[]): void {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status ?? result.signal})`);
}

/** Start a detached background process whose stdout/stderr go to `logFile`. Returns its pid. */
export function spawnBackground(
  command: string,
  args: readonly string[],
  logFile: string,
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): number {
  mkdirSync(dirname(logFile), { recursive: true });
  const fd = openSync(logFile, "a");
  try {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      detached: true,
      stdio: ["ignore", fd, fd],
    });
    child.unref();
    if (child.pid === undefined) throw new Error(`Failed to start ${command}`);
    return child.pid;
  } finally {
    closeSync(fd);
  }
}
