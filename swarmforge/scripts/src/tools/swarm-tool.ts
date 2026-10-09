// Port of swarm_tool.bb: install constitution quality tools as wrappers in .swarmforge/bin.

import { chmodSync, existsSync, mkdirSync, statSync, writeFileSync, accessSync, constants } from "node:fs";
import { dirname, join } from "node:path";
import { eprintln, exit, println } from "../core/cli.ts";
import { run } from "../core/proc.ts";
import { projectRoot } from "../core/project.ts";
import { sq } from "../core/text.ts";

interface ToolSpec {
  source?: string;
  bbTask?: string;
  needs?: string[];
  mvn?: string;
  main?: string;
  version?: string;
  paths?: string[];
  extraDeps?: Record<string, string>;
  args?: string[];
}

export const catalog: Record<string, ToolSpec> = {
  "gherkin-parser": { source: "github.com/unclebob/Acceptance-Pipeline-Specification", bbTask: "gherkin-parser" },
  "ir-dry-checker": { source: "github.com/unclebob/Acceptance-Pipeline-Specification", bbTask: "gherkin-ir-dry-checker" },
  "gherkin-mutator": { source: "github.com/unclebob/Acceptance-Pipeline-Specification", bbTask: "gherkin-mutator" },
  crap4clj: { source: "github.com/unclebob/crap4clj", bbTask: "crap4clj", needs: ["cloverage"] },
  dry4clj: { source: "github.com/unclebob/dry4clj", bbTask: "dry4clj" },
  "clj-mutate": { source: "github.com/unclebob/clj-mutate", bbTask: "clj-mutate", needs: ["cloverage"] },
  cloverage: {
    mvn: "cloverage/cloverage",
    main: "cloverage.coverage",
    paths: ["src", "spec", "test"],
    extraDeps: { "speclj/speclj": "3.13.0" },
    args: ["-p", "src", "-s", "spec", "-s", "test", "-r", "speclj"],
  },
  speclj: { mvn: "speclj/speclj", main: "speclj.main", version: "3.13.0", paths: ["src", "spec", "test"], args: ["-c", "spec"] },
  "speclj-structure-check": { source: "github.com/unclebob/speclj-structure-check", bbTask: "check" },
  crap4go: { source: "github.com/unclebob/crap4go", bbTask: "crap4go" },
  dry4go: { source: "github.com/unclebob/dry4go", bbTask: "dry4go" },
  mutate4go: { source: "github.com/unclebob/mutate4go", bbTask: "mutate4go" },
  crap4java: { source: "github.com/unclebob/crap4java", bbTask: "crap4java" },
  dry4java: { source: "github.com/unclebob/dry4java", bbTask: "dry4java" },
  mutate4java: { source: "github.com/unclebob/mutate4java", bbTask: "mutate4java" },
};

export const usageText =
  "Usage:\n" +
  "  swarm_tool.sh require <tool>\n" +
  "  swarm_tool.sh ensure <tool>\n\n" +
  `Tools: ${Object.keys(catalog).sort().join(", ")}`;

const canonical = (tool: string | undefined): string => (tool ?? "").toLowerCase();

function toolSpec(tool: string): ToolSpec {
  return catalog[canonical(tool)] ?? exit(1, `Unknown tool: ${tool}\n\n${usageText}`);
}

const binDir = (root: string): string => join(root, ".swarmforge", "bin");
const wrapperPath = (root: string, tool: string): string => join(binDir(root), canonical(tool));

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function sourceDir(root: string, source: string): string {
  const override = process.env.SWARMFORGE_TOOL_SRC;
  if (override) return override;
  return join(root, ".swarmforge", "tools", source.split("/").at(-1)!);
}

const neededTools = (tool: string): string[] => toolSpec(tool).needs ?? [];

function requireTool(tool: string): never {
  toolSpec(tool);
  const root = projectRoot();
  const missing = [tool, ...neededTools(tool)].find((name) => !isExecutable(wrapperPath(root, name)));
  if (missing) exit(1, `MISSING: ${missing}\nRun: swarm_tool.sh ensure ${missing}`);
  println("OK:", tool, wrapperPath(root, tool));
  exit(0);
}

function cloneSource(dir: string, source: string): void {
  mkdirSync(dirname(dir), { recursive: true });
  const url = `https://${source}.git`;
  const result = run("git", ["clone", "--depth", "1", url, dir]);
  if (result.exit !== 0) exit(1, `Failed to clone ${url}\n${result.err}${result.out}`);
}

function ensureSource(root: string, source: string): string {
  const dir = sourceDir(root, source);
  if (!existsSync(join(dir, "bb.edn"))) {
    if (process.env.SWARMFORGE_TOOL_SRC) exit(1, `SWARMFORGE_TOOL_SRC is missing bb.edn: ${dir}`);
    cloneSource(dir, source);
  }
  return dir;
}

const mutateRewriteBash =
  "args=()\n" +
  "scan=\n" +
  'while [ $# -gt 0 ]; do\n' +
  '  case "$1" in\n' +
  "    --mutate-all) shift ;;\n" +
  '    --scan|--update-manifest) scan=1; args+=("$1"); shift ;;\n' +
  "    --max-workers) shift; [ $# -gt 0 ] && shift ;;\n" +
  '    *) args+=("$1"); shift ;;\n' +
  "  esac\n" +
  "done\n" +
  'if [ -z "$scan" ]; then args+=(--max-workers 4); fi\n' +
  'set -- "${args[@]}"\n';

const gherkinRewriteBash =
  "args=()\n" +
  'while [ $# -gt 0 ]; do\n' +
  '  case "$1" in\n' +
  "    --level)\n" +
  '      if [ "${2:-}" = full ]; then args+=(--level hard); else args+=("$1" "$2"); fi\n' +
  "      shift; [ $# -gt 0 ] && shift ;;\n" +
  "    --workers) shift; [ $# -gt 0 ] && shift ;;\n" +
  '    *) args+=("$1"); shift ;;\n' +
  "  esac\n" +
  "done\n" +
  "args+=(--workers 4)\n" +
  'set -- "${args[@]}"\n';

function rewriteBash(tool: string): string {
  if (["clj-mutate", "mutate4go", "mutate4java"].includes(tool)) return mutateRewriteBash;
  if (tool === "gherkin-mutator") return gherkinRewriteBash;
  return "";
}

function writeWrapper(path: string, body: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `#!/usr/bin/env bash\n${body}`);
  chmodSync(path, 0o755);
  return path;
}

function writeBbWrapper(root: string, tool: string, bbTask: string, srcDir: string): string {
  const config = join(srcDir, "bb.edn");
  return writeWrapper(wrapperPath(root, tool), `${rewriteBash(tool)}exec bb --config ${sq(config)} ${bbTask} "$@"\n`);
}

const ednString = (value: string): string => JSON.stringify(value);
const coordDep = (coord: string, version: string): string => `${coord} {:mvn/version ${ednString(version)}}`;

function ednDeps(spec: ToolSpec): string {
  const main = coordDep(spec.mvn!, spec.version ?? "RELEASE");
  const extra = Object.entries(spec.extraDeps ?? {}).map(([coord, version]) => coordDep(coord, version));
  return [main, ...extra].join(" ");
}

function writeMvnWrapper(root: string, tool: string, spec: ToolSpec): string {
  const deps = `{:paths [${(spec.paths ?? []).map(ednString).join(" ")}] :deps {${ednDeps(spec)}}}`;
  const args = (spec.args ?? []).join(" ");
  return writeWrapper(
    wrapperPath(root, tool),
    `${rewriteBash(tool)}exec clojure -Sdeps ${sq(deps)} -M -m ${spec.main}${args ? ` ${args}` : ""} "$@"\n`,
  );
}

function installOne(tool: string): void {
  const spec = toolSpec(tool);
  const root = projectRoot();
  const name = canonical(tool);
  const target = spec.bbTask
    ? writeBbWrapper(root, name, spec.bbTask, ensureSource(root, spec.source!))
    : writeMvnWrapper(root, name, spec);
  println("INSTALLED:", name, target);
}

function ensureTool(tool: string): void {
  toolSpec(tool);
  for (const dep of neededTools(tool)) ensureTool(dep);
  installOne(tool);
}

export function main(args: string[]): number | void {
  if (args.some((arg) => arg === "--help" || arg === "-h")) {
    eprintln(usageText);
    return 0;
  }
  if (args.length !== 2) {
    eprintln(usageText);
    return 1;
  }
  const [command, tool] = args as [string, string];
  if (command === "require") requireTool(tool);
  if (command === "ensure") return ensureTool(tool);
  eprintln(usageText);
  return 1;
}
