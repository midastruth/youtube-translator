import { runMain } from "../core/cli.ts";
import { doneWithCurrentTask } from "../handoff/queue.ts";

runMain(doneWithCurrentTask);
