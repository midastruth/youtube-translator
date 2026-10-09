import assert from "node:assert/strict";
import { loadConfiguration, loadSources, runCucumber } from "@cucumber/cucumber/api";

export type AcceptanceSource = {
  path: string;
  ir: { name: string; scenarios: { name: string; examples: Record<string, string>[] }[] };
};

export async function runAcceptance(sources: AcceptanceSource[]) {
  const names = sources.flatMap(source => source.ir.scenarios.map(scenario =>
    `^${scenario.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));
  const expected = sources.reduce((count, source) => count + source.ir.scenarios.reduce((n, scenario) =>
    n + Math.max(1, scenario.examples.length), 0), 0);
  const { runConfiguration } = await loadConfiguration({ file: false, provided: {
    paths: sources.map(source => source.path), name: names,
    import: ["features/step_definitions/*steps.ts"], format: ["progress"], parallel: 0,
  } });
  const loaded = await loadSources(runConfiguration.sources);
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.plan.length, expected, "APS-generated scenario plan must not omit original examples");
  console.log(`APS generated executable: ${expected} scenarios`);
  const result = await runCucumber(runConfiguration);
  assert.equal(result.success, true, "Acceptance tests failed");
}
