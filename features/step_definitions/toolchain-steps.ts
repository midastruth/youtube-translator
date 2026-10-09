import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { After, Given, When, Then, setDefaultTimeout } from "@cucumber/cucumber";
import { cleanProjectCopy, command, installLockedDependencies, sourceFiles, succeeds } from "../support/project.js";

setDefaultTimeout(180_000);
let copy = "";
let scope = "";
let lastOutput = "";
let field = "";

After(() => {
  if (copy) fs.rmSync(copy, { recursive: true, force: true });
  copy = "";
});
Given("当前项目来自不含生成脚本的干净 checkout", () => { copy = cleanProjectCopy(); });
Given("已按锁文件安装项目依赖", () => { installLockedDependencies(); });
When(/^检查产品范围 "([^"]+)" 的维护源码$/, (value: string) => { scope = value; });
Then("该范围的全部手写脚本均为参与类型检查的 TypeScript", () => {
  const directory = scope === "minimal-extension" ? "minimal-extension/src" : scope;
  const files = sourceFiles(path.join(copy, directory)).filter(file => /\.(js|ts)$/.test(file));
  assert.ok(files.length > 0);
  const result = command(["npm", "run", "typecheck", "--", "--listFilesOnly"], copy);
  succeeds(result);
  for (const file of files) {
    assert.ok(file.endsWith(".ts"), file);
    assert.ok(result.stdout.includes(file), `Typecheck omitted ${file}`);
    assert.doesNotMatch(fs.readFileSync(file, "utf8"), /@ts-(?:nocheck|ignore)|as\s+unknown\s+as/);
  }
});
Then("不保留同一逻辑的手写 JavaScript 副本", () => {
  const files = sourceFiles(path.join(copy, scope === "minimal-extension" ? "minimal-extension" : scope));
  assert.equal(files.filter(file => file.endsWith(".js")).length, 0);
});
When("依次运行 npm run typecheck 和 npm run build", () => {
  succeeds(command(["npm", "run", "typecheck"], copy));
  succeeds(command(["npm", "run", "build"], copy));
});
Then("两个命令均成功退出", () => {
  assert.ok(fs.existsSync(path.join(copy, "dist/worker/server.js")));
  assert.ok(fs.existsSync(path.join(copy, "minimal-extension/public/content.js")));
});
Then("严格类型检查覆盖 worker、扩展和验收步骤", () => {
  const config: { compilerOptions: { strict?: boolean }; include: string[] } = JSON.parse(fs.readFileSync(path.join(copy, "tsconfig.json"), "utf8"));
  assert.equal(config.compilerOptions.strict, true);
  const result = command(["npm", "run", "typecheck", "--", "--listFilesOnly"], copy);
  succeeds(result);
  for (const file of ["worker/server.ts", "minimal-extension/src/content.ts", "features/step_definitions/steps.ts", "features/step_definitions/toolchain-steps.ts"]) {
    assert.ok(result.stdout.includes(path.join(copy, file)), file);
  }
});
Then("构建结果不依赖全局 TypeScript 工具或旧 JS 文件", () => {
  assert.ok(fs.existsSync(path.join(copy, "node_modules/typescript/bin/tsc")));
  const pkg: { scripts: Record<string, string> } = JSON.parse(fs.readFileSync(path.join(copy, "package.json"), "utf8"));
  assert.equal(pkg.scripts.typecheck, "tsc --pretty false");
  assert.ok(fs.existsSync(path.join(copy, "dist/worker/agent-worker.js")));
  assert.equal(fs.existsSync(path.join(copy, "worker/server.js")), false);
});
Then("再次构建无需手工修复或复制脚本", () => { succeeds(command(["npm", "run", "build"], copy)); });
Given(/^在隔离副本中对迁移后的 "([^"]+)" 类型的 "([^"]+)" 字段赋予字符串值$/, (domain: string, value: string) => {
  field = value;
  const directory = domain === "subtitle cue" ? "worker" : "minimal-extension/src";
  const content = domain === "subtitle cue"
    ? `import type { SourceCue } from './types.js';\nconst cue: SourceCue = { cue_id: 'c0', start: 'wrong', end: 1000, text: 'Hello' };\n`
    : `import type { ExtensionSettings } from './types.js';\nconst settings: Pick<ExtensionSettings, 'translateWhole'> = { translateWhole: 'wrong' };\n`;
  fs.writeFileSync(path.join(copy, directory, "type-failure.ts"), content);
});
When("对该副本运行项目类型检查命令", () => {
  const result = command(["npm", "run", "typecheck"], copy);
  assert.notEqual(result.status, 0);
  lastOutput = result.stdout + result.stderr;
});
Then("命令因该字段的类型不匹配而失败", () => {
  assert.match(lastOutput, /type-failure\.ts.*TS2322/);
  assert.match(lastOutput, /Type 'string' is not assignable to type '(?:number|boolean)'/);
  assert.ok(["start", "translateWhole"].includes(field));
});
Then("失败不是缺少工具、依赖或配置造成的启动错误", () => {
  assert.doesNotMatch(lastOutput, /not found|Cannot find module|TS2307|command not found/);
});
