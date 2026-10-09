import assert from "node:assert/strict";
import { test } from "node:test";
import { generateFeature } from "../features/generator.js";

test("APS step text, backgrounds, and example values drive generated executable scenarios", () => {
  const output = generateFeature({ name: "Fixture", background: [{ keyword: "Given", text: "a setup" }], scenarios: [
    { name: "an outline", steps: [{ keyword: "When", text: 'run "<value>"' }, { keyword: "Then", text: "result <value>" }], examples: [{ value: "one" }, { value: "two" }] },
    { name: "a table", steps: [{ keyword: "Given", text: "source table" }], examples: [] },
  ] }, new Map([['a table\nsource table', [["text", "time"], ["Hello | goodbye", "100"]]]]), new Map([["a table", ["@contract"]]]));
  assert.equal((output.match(/Scenario: an outline/g) || []).length, 2);
  assert.equal((output.match(/Given a setup/g) || []).length, 3);
  assert.match(output, /When run "one"\n    Then result one/);
  assert.match(output, /When run "two"\n    Then result two/);
  assert.match(output, /@contract\n  Scenario: a table/);
  assert.ok(output.includes("| Hello \\| goodbye | 100 |"));
  assert.doesNotMatch(output, /<value>/);
  assert.throws(() => generateFeature({ name: "Bad", scenarios: [{ name: "missing", steps: [{ keyword: "Given", text: "<absent>" }], examples: [{}] }] }), /Unbound example/);
});
