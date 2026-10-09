import { runMain } from "../core/cli.ts";
import { readyForNext } from "../handoff/queue.ts";

runMain(readyForNext);
