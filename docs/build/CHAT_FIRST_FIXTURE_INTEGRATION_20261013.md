# Chat-first fixture integration — 2026-10-13

**Ready for the parent integration gate at 2026-10-13T18:30:42Z.** Final whole
owned files pass **106/106** and release IPC passes **21/21**: **127 total**,
zero failures, skips or cancellations. No unresolved production defect was
observed in this scope. This is bounded fixture proof, not a global regression,
package or genuine native acceptance claim.

Owned scope: `chat-onboarding`, `codex-chat-ui`, `composer-model-picker`,
`frontend-simplicity`, `settings-confirmation-layer`, `studio-ui`,
`workspace-navigation-ui`, `workspace-unified`, and the added
`provider-setup-ui` / explicit-login watcher coverage; release ownership is
`tests/release/provider-setup-ipc.test.mjs` only. No production edits, other
workers' tests, root build, installation, live provider/model or Studio calls.

Evidence lives in `runtime/verification/chat-first-fixture-integration-20261013/`.
Initial private compilation enumerated 167 sources and passed. Per-file UTC
capture times and SHA-256 values are in `inputs-before.json` and
`inputs-after.json`; no input changed during that compile.

`owned-initial.tap` retains the complete initial result: **96 tests, 89 passed,
7 failed, zero skips/cancellations**. Four Codex browser cases stop at an obsolete
native selection ACK wait: an open local draft now stores its model choice
locally until the explicit open gesture. Other failures expect a hidden static
sign-in card, omit the fixed `chat-tabs.js` dynamic import, and count the global
search popup's legitimate tool option as removed topbar tool navigation.

Fixture changes serve the real private compiled `chat-tabs.js`, `task-usage.js`,
`task-usage-ui.js` and optional workflow modules for production Studio startup.
The simplicity fixture also consumes compiled controller bytes instead of
independently stripping current TypeScript. Codex resume setup is being changed
to create an acknowledged native thread and exact saved project/session binding
before reopening it; arbitrary raw IDs remain refused.

`ipc-contract.tap` passes **21/21** with zero skips/cancellations. Production main
IPC, preload validators, provider setup and `provider-login.cjs` run together in
VM fixtures. The new login exercises fixed native stdio initialize/account
read/login start, unknown pending status, matching completion, fresh account ACK
and child closure. Its OAuth URL stays in the trusted main sink and no signup,
inference/model/thread RPC or real executable is used. Claude retains its fixed
terminal handoff. `ipc-initial.tap` retains the earlier cross-VM array-prototype
fixture mismatch corrected with `Array.from`, without changing production guards.

`owned-contract.tap` retains **43 tests, 40 passed, 3 failed** after the first
repairs. All six new explicit-login watcher tests passed: exact 2000 ms polling,
450-poll cap, subscription only after a final nonbusy ACK, one metadata connect
intent, inert mount/cache/preference/resume, A→B→A stale replies, lifecycle
cancellation, malformed/error replies, disabled native connect and no automatic
disconnect. The controlled provider bridge tracks intents; the existing Codex
browser suite separately runs the real HUMAN HTTP service and synthetic SDK.

`owned-repaired.tap` retains **32 tests, 31 passed, 1 failed**. The remaining
failure expected empty localStorage despite the requested per-project chat
presentation persistence. Its replacement checks the exact two storage keys,
exact bounded preference fields and exclusion of HUMAN/AGENT bearers. Other
repairs distinguish a connected metadata session from an unbound saved tab,
and test public history loading once at explicit chat open plus exactly one
additional manual read with no duplicate public text or inference/grants.

The final scoped compile passed with unchanged input hashes. It recompiles only
the ten owned test roots and their actual **80-source** production/test
dependency closure; shared `dist` and other workers' compiled tests are not
rebuilt. The initial full 167-source private emission remains separate from
this current scoped emission. `delivery-inputs-before.json` and
`delivery-inputs-after.json` capture exact source bytes and UTC times;
`delivery-compile.log` contains the compiler's actual input list. `proof.json`
checks all 80 source-map `sourcesContent` hashes against both captured inputs
and current sources, with **zero mismatches**. IPC's six production/test inputs
match before/after/current hashes separately.

Each final whole file has its own retained TAP log and screenshot environment.
The composer fixture retains its directory convention; other screenshot
fixtures receive distinct file paths. There is no shared global screenshot
path in the authoritative final runs. Earlier common-path and envelope failures
remain in the superseded logs.

| Whole owned file | Passed | Failed | Skipped |
| --- | ---: | ---: | ---: |
| `chat-onboarding.test.ts` | 12 | 0 | 0 |
| `codex-chat-ui.test.ts` | 25 | 0 | 0 |
| `composer-model-picker.test.ts` | 7 | 0 | 0 |
| `frontend-simplicity.test.ts` | 2 | 0 | 0 |
| `settings-confirmation-layer.test.ts` | 2 | 0 | 0 |
| `studio-ui.test.ts` | 33 | 0 | 0 |
| `workspace-navigation-ui.test.ts` | 1 | 0 | 0 |
| `workspace-unified.test.ts` | 14 | 0 | 0 |
| `provider-setup-ui.test.ts` | 4 | 0 | 0 |
| `provider-login-intent-watcher.test.ts` | 6 | 0 | 0 |
| **Owned unit total** | **106** | **0** | **0** |
| `tests/release/provider-setup-ipc.test.mjs` | **21** | **0** | **0** |

`whole-owned-final.json` names each authoritative log. Eight unchanged files
passed in the per-file full run. The two files subsequently changed for explicit
history ACK synchronization and a paused virtual clock passed as whole files in
`final-synchronized-codex-chat-ui.tap` and
`final-synchronized-provider-login-intent-watcher.tap`. Their previous failed
logs are retained; no retry-until-green mechanism was used. The virtual clock
still advances exactly 2000 ms per watcher tick and verifies exactly 450 polls.

`owned-final.tap` retains the superseded **105/106** run whose storage assertion
incorrectly expected the native `activeTabId` envelope rather than browser
`activeKey`. `whole-owned-perfile-initial.json` and its logs retain **104/106**:
the history count was read before the explicit open's final history ACK, and
the unpaused test clock advanced 2 ms between login and timer scheduling. The
fixtures now wait for `History loaded.` within the existing 8-second bound and
pause the virtual clock before mounting. Earlier **31/32** failure was the old
empty-localStorage assertion at emitted line 490, not console errors. All
zero-page/console-error, XSS, denial, authority, exact project/session/model,
grant and closure assertions remain. Native fixture counts are explicitly
asserted and recorded as **37 created / 37 closed / 19 targeted reads**.

Edited repository paths:

- `tests/unit/codex-chat-ui.test.ts`
- `tests/unit/composer-model-picker.test.ts`
- `tests/unit/frontend-simplicity.test.ts`
- `tests/unit/studio-ui.test.ts`
- `tests/unit/workspace-navigation-ui.test.ts`
- `tests/unit/workspace-unified.test.ts`
- `tests/unit/provider-login-intent-watcher.test.ts` (new focused owned suite)
- `tests/release/provider-setup-ipc.test.mjs`
- `docs/build/CHAT_FIRST_FIXTURE_INTEGRATION_20261013.md`
- `runtime/verification/chat-first-fixture-integration-20261013/` (private runner,
  compiler configuration/emission, manifests, retained TAP and screenshots)

`chat-onboarding`, `settings-confirmation-layer` and `provider-setup-ui` were
validated whole and required no edits in this pass. Pre-existing shared changes
in owned files were preserved.

Real Edge version: **155.0.4283.45**. Production asset SHA-256:

```text
studio.html 9b914bf3066c845111611e50a8452d3436d0973db656e3fb8bbf2456c959ab56
studio.css  c13f70eb64211c8d3765d68401cc58574db42bfaf7de794a035626d672e6acfa
```

Already installed `zod` and `zod-to-json-schema` were copied into private emission
for inherited dependency resolution. Nothing was installed. Edge runs used the
authorized elevated execution environment after earlier workers documented that
Edge cannot launch within the Windows filesystem sandbox. All HTTP/SDK/native
bridge behavior was controlled: **zero installed provider CLI operations,
zero live model turns, zero live Studio operations**, no signup or credential
access. Spawned Node protocol fixtures are synthetic and are not a native CLI.

Reproduction: run `compile-owned.mjs delivery`, then `run-final.mjs` and
`run.mjs ipc-final` in the owned proof directory using Node from the repository
root. The final source edits are stable for the parent's fresh shared compile.
The parent still owns the full global gate, release package/host hooks and real
native acceptance; this sidecar supplies no proof for those unperformed gates.
