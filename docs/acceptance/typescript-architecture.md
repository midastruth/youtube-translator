# TypeScript architectural review

Task: `把js 改为ts`.

## Boundaries

- Worker rule modules import framework-independent `domain-types.ts`. The existing `types.ts` remains a compatibility facade for application consumers and holds lifecycle/framework-specific records. No public field shapes or durable document versions change.
- The HTTP snapshot route asks `AgentWorker.snapshotJob` for the application view instead of knowing the durable harness, document definition or persistence representation. Tests exercise the committed view, missing-document fallback and actual HTTP delegation.
- Page-world caption interception asks pure caption-selection rules for language rank, player-track choice and original-language URL classification. The bridge reuses the existing video-ID and subtitle-presence functions rather than repeating their answers. Fetch/XHR interception, XML DOM parsing and polling stay at the browser boundary.
- Worker lifecycle, durable transitions, request budgets/retry policy, stream observation, review and validation remain separate responsibilities. No workflow redesign or translation-quality expansion is included.
- Architecture tests pin the intended inward dependencies, including type-only imports. Test helpers live separately under `tests/support/`. Existing browser/worker acceptance helpers are unchanged.

## Verification

- `npm ci` with a worktree-local npm cache and `npm run typecheck` passed.
- `npm run verify` passed: 46 unit/architecture tests, 75 APS-generated acceptance scenarios / 1192 steps, and 8 separately executed property groups. The deliberate ownership-conflict acceptance case logs its expected diagnostic.
- `jscpd@5.4.1 worker minimal-extension/src features scripts --format typescript --workers 4` found only the previously documented acceptance assertion clone: 8 lines / 0.15%. No new product clones were reported.
- There are no `features/*.feature` files; maintained feature sources live in `docs/acceptance/` and run through the existing APS adapter.

## Tool verification pending

The inbound refactoring report records operator-approved scan-only TS tooling. That toolchain is not available on this worktree's PATH and `swarm_tool.sh` does not recognize TS tool names. The currently published npm `ts-mutate@1.0.2` has a different Stryker-wrapper interface and rejects `--scan`; its advertised GitHub repository is unavailable. The npm `crap4ts@1.0.1` interface also differs from the inbound tool invocation. These packages were installed only in ignored scratch space; they were not substituted silently for the approved tools.

Operator clarification requests `clar-20261009T144130042Z` and `clar-20261009T144930423Z` request the approved tool provenance and verification exceptions. No language or Gherkin mutations have been executed, no manifests have been edited, and the role's final tool sequence/handoff is pending resolution. Prior-role CRAP numbers are not represented as newly verified results.

This review does not claim real-browser installation, real-model quality or Python-backend verification. Scratch reports, tool installations and the preserved startup-script backup remain ignored.
