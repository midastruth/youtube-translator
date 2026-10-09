import { runMain } from "../core/cli.ts";
import { readyForNextBatch } from "../handoff/queue.ts";

runMain(readyForNextBatch);
