# Cancel an owned playtest during durable admission

A playtest run receives its owned run ID before the ledger finishes consuming
consent and recording admission. Stop previously rejected that exact run until
execution existed, allowing an admitted start to continue after cancellation.

The controller now accepts Stop for its exact pending admission or execution.
It requests cancellation synchronously, then joins the same admission and owned
cleanup. Foreign run IDs remain rejected. An admission rejection retains its
original outcome/code; cancellation does not rewrite it or replay a native action.

Four new regressions hold real ledger operations and exercise the production
controller and service:

- Cancellation after the consent-consumption write reaches disk.
- Cancellation after the admission write reaches disk; concurrent Stop and
  shutdown share one cleanup and one terminal record.
- Cancellation while the actual ledger rejects a foreign consent preserves
  `rejected` / `HUMAN_AUTH_REQUIRED` and dispatches no native mutation.
- The actual service cancel path joins two concurrent cancellations, closes its
  SDK connection once, releases the scene reservation and dispatches no play start
  or blind stop.

Validation in the isolated `Arcane-pt` worktree:

- Build passed with 267 explicit product sources.
- Six-file run: 206 tests passed, zero failures, cancellations or skips; 24.88 seconds.
- Inventory: `studio-test-admission-cancel`, `studio-test-controller-regressions`,
  `studio-test-service`, `studio-test-routes`, `studio-test-unavailable`, and
  `mcp-playtests` under `dist/tests/unit/*.test.js`.
- `git diff --check` passed. The five previously exported MCP patch files were
  retained without edits.

Integration on `main` based on `cb68c244db9e55678a63280ee3774022a2d9db94`
passed with 269 compiled sources. The six suites above plus the actual Windows
deep-path SQLite suite completed 210/210 cases, with zero failures, cancellations
or skips (21.541 seconds). Logs: `runtime/admission-main-build.log` and
`runtime/admission-main-tests.log`.

The tests use real fsynced journals, SQLite, SDK transports and production control
paths with synthetic native peers. They launch no Studio executable or provider
and establish no native runtime acceptance.
