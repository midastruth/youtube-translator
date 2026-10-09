// Port of merge_and_process.bb.

import { eprintln, exit, println } from "../core/cli.ts";
import { run } from "../core/proc.ts";

export const usageText = "Usage: merge_and_process.sh <sender> <commit>";

function alreadyMerged(sha: string): boolean {
  return run("git", ["merge-base", "--is-ancestor", sha, "HEAD"]).exit === 0;
}

export function mergeCommit(sender: string, sha: string): void {
  if (!alreadyMerged(sha)) {
    const result = run("git", ["merge", "--no-edit", "-m", `Merge ${sender} ${sha}`, sha]);
    if (result.exit !== 0) exit(1, `${result.err}\n${result.out}`.trim());
  }
  println("MERGED:", sender, sha);
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
  mergeCommit(args[0]!, args[1]!);
}
