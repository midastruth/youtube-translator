// Process-level helpers for the CLI entry points.
// Deep code throws `CliExit` instead of calling process.exit so stdout drains and
// `finally` blocks (lock release) run.

export class CliExit extends Error {
  readonly code: number;
  constructor(code: number, message = "") {
    super(message);
    this.code = code;
  }
}

/** Print `message` to stderr (when non-empty) and exit with `code`. */
export function exit(code: number, message?: string | null): never {
  throw new CliExit(code, message ?? "");
}

export function out(text: string): void {
  process.stdout.write(text);
}

export function println(...parts: unknown[]): void {
  process.stdout.write(`${parts.map(String).join(" ")}\n`);
}

export function eprintln(...parts: unknown[]): void {
  process.stderr.write(`${parts.map(String).join(" ")}\n`);
}

type MainResult = void | number;

function fail(error: unknown): void {
  if (error instanceof CliExit) {
    if (error.message) eprintln(error.message);
    process.exitCode = error.code;
    return;
  }
  eprintln(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

function settle(code: MainResult): void {
  if (typeof code === "number") process.exitCode = code;
}

/** Run `fn` as a CLI main: map CliExit and other errors to exit codes. */
export function runMain(
  fn: (args: string[]) => MainResult | Promise<MainResult>,
  args = process.argv.slice(2),
): void {
  try {
    const result = fn(args);
    if (result instanceof Promise) result.then(settle, fail);
    else settle(result);
  } catch (error) {
    fail(error);
  }
}
