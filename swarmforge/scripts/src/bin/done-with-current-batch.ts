import { runMain } from "../core/cli.ts";
import { doneWithCurrentBatch } from "../handoff/queue.ts";

runMain(doneWithCurrentBatch);
