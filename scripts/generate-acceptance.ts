import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { generateMessages } from "@cucumber/gherkin";
import { IdGenerator, SourceMediaType } from "@cucumber/messages";
import { generateFeature, type AcceptanceIR } from "../features/generator.js";

const sources: { path: string; ir: AcceptanceIR }[] = JSON.parse(fs.readFileSync("./tmp/acceptance-sources.json", "utf8"));
const generated = sources.map(source => {
  // APS IR does not currently carry data tables or tags. Use the official
  // Cucumber adapter solely to retain those; scenario/step/example text comes
  // from APS IR, not a parallel project parser or original-file execution.
  const envelopes = generateMessages(fs.readFileSync(source.path, "utf8"), source.path, SourceMediaType.TEXT_X_CUCUMBER_GHERKIN_PLAIN, {
    includeGherkinDocument: true, includePickles: false, newId: IdGenerator.incrementing(),
  });
  assert.equal(envelopes.some(envelope => envelope.parseError), false);
  const feature = envelopes.find(envelope => envelope.gherkinDocument)?.gherkinDocument?.feature;
  assert.ok(feature);
  const tables = new Map<string, string[][]>();
  const tags = new Map<string, string[]>();
  for (const child of feature.children) {
    if (!child.scenario) continue;
    const scenario = child.scenario;
    tags.set(scenario.name, [...feature.tags, ...scenario.tags].map(tag => tag.name));
    for (const step of scenario.steps) if (step.dataTable) {
      tables.set(`${scenario.name}\n${step.text}`, step.dataTable.rows.map(row => row.cells.map(cell => cell.value)));
    }
  }
  const output = `./tmp/generated-${path.basename(source.path)}`;
  fs.writeFileSync(output, generateFeature(source.ir, tables, tags));
  return { path: output, ir: source.ir };
});
fs.writeFileSync("./tmp/acceptance-runner.ts", `import { runAcceptance } from '../features/runtime.ts';\nawait runAcceptance(${JSON.stringify(generated)});\n`);
