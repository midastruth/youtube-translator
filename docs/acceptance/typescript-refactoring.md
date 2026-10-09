# TypeScript refactoring verification

Task: `把js 改为ts`.

## Preserved boundaries

- Extracted subtitle request construction, track selection, VTT formatting, cue lookup, and SSE decoding from the browser DOM adapter. Browser scripts still build to the original manifest paths.
- Separated request budgets from retry policy, stream observation from worker lifecycle, scripted fallback drafts from durable transitions, and revision prompts from review rules. Public worker exports remain available through their original modules.
- Retained validation error order, present-but-invalid versus missing cue handling, glossary/review rule precedence, timestamps, job-key normalization, and the distinct checkpoint issue-reset behavior of review versus validation failures.
- Static duplication review removed repeated overlay teardown and block checkpoint construction. The remaining clone is two existing acceptance assertions; these were not consolidated or weakened.
- No mutation manifests existed in the inbound tree; scans did not create or edit manifests. No mutation tests were run.

## Tool scope

The operator approved `ts-mutate` (scan only), `crap4ts`, and `jscpd` for this TypeScript task, because the constitution's Clojure tools cannot analyze these sources.

Node's native TS loading preserves source offsets for `crap4ts`'s V8-to-Istanbul coverage conversion. The resolver hook does not transpile source or replace dependency resolution. Tests remain separate from property verification; `npm test` contains the explicit Node test command so `crap4ts` can recognize its runner.

CRAP scope: all worker modules, the extracted browser-independent subtitle modules and payload schemas, and the acceptance IR generator. DOM/bootstrap adapters and command-entry scripts are not Node-source coverage targets. Browser adapter behavior is exercised through the existing controlled DOM tests of actual bundled output.

Mutation-site counts were reviewed for product, acceptance, and build sources. Worker lifecycle/streaming, retry/budget, durable workflow/fallback, and browser domain/DOM responsibilities were split. Large remaining browser capture/render orchestration modules and declarative acceptance step collections were not arbitrarily split to meet a site-count quota.

## Verification

- `npm run verify`: 38 unit tests, 75 acceptance scenarios / 1192 steps, and 8 separately executed properties passed.
- Properties use fast-check with seed `20261009`, 200 cases each: partition conservation/context budgets; validator encodings/order/timestamps; cache normalization; budget conservation; cue lookup; millisecond formatting round trips; JSON3 normalization idempotence; SSE byte-boundary invariance.
- `npm run test:coverage`: native Node unit coverage, excluding properties. Extracted subtitle request/stream/formatting modules, default draft, glossary, streaming, budget, review, and validator have 100% line coverage. Remaining adapter/workflow coverage is intentionally reported, not hidden.
- `crap4ts worker minimal-extension/src/subtitles.ts minimal-extension/src/stream-request.ts minimal-extension/src/subtitle-stream.ts minimal-extension/src/types.ts features/generator.ts`: maximum CRAP 9.53, within the role's <=10 requirement. The tool exits 2 because its built-in threshold is the stricter 8.00; this is not represented as a clean tool exit.
- `jscpd worker minimal-extension/src features scripts --format typescript --workers 4`: duplication reduced from four clones / 0.98% lines to one clone / 0.15% lines (existing acceptance assertions).
- `ts-mutate <source> --scan`: source-site discovery only. Scan mode rejects execution flags, so no worker flag is passed; it creates no mutation workers.

## Post-commit requirement audit

| Requirement | Evidence / boundary |
| --- | --- |
| TS is the sole maintained product/step source | Toolchain-01 enumerates source files and `tsc --listFilesOnly`; no tracked worker, extension or step JS remains. Strict typecheck and both injected field-type failures execute in isolated copies. |
| Clean, local build and runnable worker | Toolchain-02 performs two builds without old JS; worker-01 launches `npm run worker` with default and explicit ports and an isolated database. Existing dependency versions are unchanged; only fast-check and pure-rand are added for property testing. |
| Preserve HTTP, cue identity, milliseconds, defaults and keys | Worker-02 exercises real HTTP submit/stream/snapshot; worker-03 asserts both frozen keys; unit/property tests cover ordering, failed output, retry classification, budgets and retained publications. |
| Preserve browser entry paths, settings, rendering and export | Extension-01 executes all four built scripts and checks manifest/HTML/icons and MAIN-world timing; extension-02 checks the explicit legacy model fixture; extension-03 exercises duplicate cue updates and real VTT export. |
| Preserve off-by-default navigation and fallback isolation | Extension-04 starts with an active old video and sends late old-stream events; extension-05 checks JSON3/XML, offsets, JSON string details, source identity and absence of Cookie. |
| Do not change behavior through extraction | Full committed-diff review found the source cue count had moved across the asynchronous snapshot. It is captured before the await again, with a regression test that mutates the record during snapshot. Checkpoint issue resets, review ordering, placeholder rejection and API/settings shapes were reviewed against the inbound implementation. |
| Preserve existing acceptance, isolate properties, do not run mutations | All 75 APS-generated scenarios remain; `verify` runs the eight property groups separately. Coverage and CRAP use `npm test` or unit commands without property execution. Scans only; no manifests manually edited. |
| Avoid unrelated changes and overstated claims | Python and SwarmForge are untouched; only task code/tests/docs are committed. Scratch/bootstrap backup and generated output remain ignored. Browser installation and real-model quality remain explicitly unverified. |

Root and extension developer instructions retain install/build/start/reload guidance. The complete inbound payload, scope documents, committed diff, test adapters, generated entry layout, reports, and working-tree state were reviewed. Remaining limitations are the documented stricter tool threshold, one retained assertion clone, environment-adapter source coverage exclusions, and the pre-existing mock/empty assertions in legacy acceptance—not new claims of completeness for the older translation-quality contract.

Reports and generated acceptance output stay ignored in `./tmp/` and `./coverage/`. These checks do not claim real-browser installation, real-model translation quality, or Python-backend verification.
