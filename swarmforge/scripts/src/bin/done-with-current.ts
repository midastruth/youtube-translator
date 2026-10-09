import { runMain } from "../core/cli.ts";
import { doneWithCurrent } from "../handoff/queue.ts";

runMain(doneWithCurrent);
