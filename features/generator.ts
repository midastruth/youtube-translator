export type AcceptanceStep = { keyword: string; text: string };
export type AcceptanceIR = {
  name: string; background?: AcceptanceStep[];
  scenarios: { name: string; steps: AcceptanceStep[]; examples: Record<string, string>[] }[];
};

export function generateFeature(ir: AcceptanceIR, tables = new Map<string, string[][]>(), tags = new Map<string, string[]>()) {
  const lines = [`Feature: ${ir.name}`];
  const cell = (value: string) => value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/\|/g, "\\|");
  for (const scenario of ir.scenarios) {
    for (const example of scenario.examples.length ? scenario.examples : [{}]) {
      const expand = (text: string) => text.replace(/<([^>]+)>/g, (_, parameter: string) => {
        if (!(parameter in example)) throw new Error(`Unbound example: ${parameter}`);
        return example[parameter];
      });
      const scenarioTags = tags.get(scenario.name) || [];
      if (scenarioTags.length) lines.push(`  ${scenarioTags.join(" ")}`);
      lines.push(`  Scenario: ${expand(scenario.name)}`);
      for (const step of [...ir.background || [], ...scenario.steps]) {
        lines.push(`    ${step.keyword} ${expand(step.text)}`);
        const table = tables.get(`${scenario.name}\n${step.text}`);
        if (table) for (const row of table) lines.push(`      | ${row.map(value => cell(expand(value))).join(" | ")} |`);
      }
    }
  }
  return lines.join("\n") + "\n";
}
