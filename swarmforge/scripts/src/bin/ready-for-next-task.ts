import { runMain } from "../core/cli.ts";
import { readyForNextTask } from "../handoff/queue.ts";

runMain(readyForNextTask);
