# Playtest MCP report validation

The MCP client validates the complete playtest job, consent display and controller
review before returning them as tool evidence. Unknown fields, contradictory
outcomes, unsupported acceptance claims and mismatched bindings/digests are
rejected. A retained runtime error cannot satisfy success when the admitted policy
fails on runtime errors; disabling that policy still permits the corresponding
bounded outcome. Job IDs and hashes must consume their entire wire strings.

Preparation uses one private normalized request copy. Response expectations retain
the submitted session, optional native target and bounded settings even if a
direct client caller later mutates its original object. Single-job status and
cancel require the exact requested job; listing requires a unique bounded list.
Malformed POST acknowledgements retain the existing unknown/ambiguous result and
are never retried. Malformed reads return a protocol error.

Validation preserves pending cancellation without a run, asynchronous controller
cleanup, unknown cleanup with a human-review fence, and late cancellation of an
already completed report. A succeeded runtime outcome does not imply verified
cleanup. Fixture/native labels remain distinct, and both acceptance fields must
remain false. This patch grants no consent, native execution or other authority.

Validation on the isolated worktree based on `9745b9ac14c064dc997463eb4b7736bf63368624`:

- `npm run build`: passed, 266 explicit product sources.
- Seven-file focused run: 275 tests; 274 passed, zero failures or cancellations,
  one existing skip; 29.20 seconds.
- Inventory: `mcp-playtests`, `mcp`, `studio-test-service`, `studio-test-routes`,
  `studio-test-decoders`, `studio-test-controller-regressions`, and
  `studio-test-unavailable` under `dist/tests/unit/*.test.js`.
- The skipped decoder case requires historical native evidence that is absent
  from this checkout; it makes no runtime acceptance claim.
- `git diff --check`: passed.

Integration on `main` based on `6d9c3a00e12cda870c8c0984cd4ef5704c0a7201`
also passed: 268 explicit sources compiled; the seven suites above plus the actual
deep-path SQLite suite completed 279 cases, with 278 passed, zero failures or
cancellations and the same one existing skip (29.314 seconds). Evidence is retained
in `runtime/playtest-main-build.log` and `runtime/playtest-main-tests.log`.

The new SDK/HTTP tests use synthetic daemon reports and held/lost acknowledgements.
The service fixtures validate actual SDK, controller, authenticated store and
durable ledger behavior, including preserving the original journal after a late
cancel. No Studio executable or provider was launched. Native runtime acceptance
and customer gameplay correctness remain unverified.
