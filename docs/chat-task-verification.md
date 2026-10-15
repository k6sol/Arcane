# Managed chat verification

A human Send creates an owned task for its exact project, conversation, native
connection, model and permissions. Arcane retains the task while the user changes
tabs. Gameplay verification can then settle into that same task and, for a
measured assertion failure, continue with one bounded repair and one verification
of the same scenario.

Each Send uses a fresh isolated native process and MCP credential. The host
captures task identity from that credential and the actual acknowledged native
operation. Request JSON cannot supply a task origin. Explicitly injected legacy
clients retain their existing test lane, with no managed task or repair
capability; the production client requires a reported account identity.

## Verification and repair

The [finite gameplay scenario](studio-gameplay-scenarios.md) remains a separate
human approval. Its immutable display includes the ordered inputs, assertions,
execution limit and any temporary changes with their expected baselines. The
panel submits the exact displayed digest. A repair's second test receives its own
approval of the same scenario and freshly observed source scope.

The test service publishes a settled packet after input release, owned Play stop,
temporary restoration and dedicated connection cleanup. The packet binds the
exact job, display, scenario, subjects and report digests. Arcane also waits for
the original native turn's acknowledgement and terminal state, then reads the
source scope again through a fresh connection before advancing the task.

| Settled evidence | Task behavior |
| --- | --- |
| Passed scenario, complete cleanup and current sources | Record bounded verification |
| First measured `ASSERTION_FAILED`, complete cleanup and current sources | Reserve one repair on the original client |
| Same scenario passes after repair | Record bounded verification |
| Second measured assertion failure | Record the task's measured failure |
| Changed sources, missing evidence or uncertain cleanup | Pause for review |
| Native dispatch with uncertain acknowledgement | Retain uncertainty for explicit recovery |

Only the private, one-use continuation from the original client can dispatch the
repair. It binds the reported account, thread, session, model, effort and original
permission policy. The repair prompt names the settled job and report digest.
There is no automatic model change, permission expansion or additional repair
round. Runtime errors and ambiguous console output remain distinct from a
measured gameplay assertion.

## Conversation controls and lifecycle

The task panel shows retained state and the latest report digest. Opening a
retained task selects its original live client and saved history, including
pending approvals, without starting or resuming a process. Approval responses use
that original client's existing approval handle.

Stop targets the exact selected task. Write/asset revocation and Disconnect
retire the relevant conversation's authority. A later human Send cancels the
previous task in that conversation and establishes fresh scope. Pending focus,
resume and dispatch operations recheck their lifecycle after each asynchronous
boundary. Controls for another conversation cannot cancel the selected task.

Daemon shutdown closes task admission synchronously before the test service can
publish its final packet. All retained owners receive cleanup even if an
individual journal update fails. The task journal keeps bounded metadata and
settled evidence in a project-bound SQLite database with one live owner. Restart
retains interrupted state for review; private native handles and continuations
are not reconstructed and pending repairs are not replayed.

## Evidence scope

Local integration exercises the production lab, HTTP routes, MCP SDK, native
client protocol, SQLite stores, fsynced test ledger and exact production Client
program in pinned standalone Luau. The provider peer, engine objects, physics,
plugin heartbeat and image pixels are explicit fixtures. Separate browser checks
exercise the compiled panel, exact consent digest, measured-row refresh, scoped
PNG retrieval, hash verification and preview removal.

Bounded scenario verification describes these observed assertions. Native Studio
input delivery, Client capture, customer gameplay and full product acceptance
retain their separate evidence requirements. Public reports continue to expose
`nativeAcceptance: false`. See [standalone Luau setup](standalone-luau-tests.md)
and [temporary setup storage](studio-test-reservation-storage.md).

## Validation recorded on 15 October 2026

The integrated build compiled 290 explicit sources. The complete compiled unit
inventory passed 2,713 tests with zero failures and 74 optional browser/native
checks skipped. The final task acknowledgement, click-coordinate and picker
changes received a subsequent build and focused integration verification.
That final 19-file inventory passed 400 tests, with zero failures and one
historical native-evidence check skipped, in 117.321 seconds. It includes the
actual production lab repair/reverify flow, the initial acknowledgement journal
fault, coordinate preflight and release, temporary restoration, HTTP/MCP
decoding, deep Windows storage and bundled MCP startup. Logs are
`runtime/joint-gameplay-publish-build.log` and
`runtime/joint-gameplay-publish-tests.log`; the complete earlier inventory is
`runtime/joint-full-unit-tests.log`.

The release inventory retained its original 450-case report: 446 passes, one
historical skip and three failure counts from two leaf cases and a parent group.
The shutdown fixture needed the new private task-fence binding; the other case
reported a Windows `realpath` `EBADF`. After updating only the shutdown fixture,
both affected files passed 101/101 checks. The missing-file assertion remained
unchanged. Logs and UTF-8 receipts are retained under
`runtime/joint-release-tests*` and `runtime/joint-release-targeted*`.

Plugin build and deterministic artifact checks passed, with 405 plugin tests
passing and one optional analyzer check skipped. All 32 skill tests passed;
integrity validation covered 50 skills and 15 references. The receipt is
`runtime/joint-plugin-skills-summary.json`.

Installed Edge covered 126 unique affected client/UI cases through 123 initial
passes and three focused passing reruns with unchanged deadlines. The corrected
picker sequence also passed against the exact earlier main UI, with the other 11
onboarding cases already passing there. The browser record combines that initial
inventory with the three focused reruns. Exact source identities and logs are
recorded in the isolated worktree's
`runtime/chat-task-loop-final-evidence.json`.

The production gameplay panel separately passed its Edge replay: readable steps
and temporary baselines before consent, exact digest approval, same-state result
and image refresh, scoped PNG/hash retrieval and preview removal. Source SHA-256
is `14d34ea5958ad568e788208faa56e89ae411f52dc2a873572659f54720249bfb`;
compiled SHA-256 is
`339ecf76a8f13a0602986abba3690eb5c92910f750775852c6d54581026964df`.
Both identities match the final integrated build. The retained replay, JSON
receipt and screenshots are `runtime/scenario-panel-browser*`.

All process and gameplay fixtures in this validation use owned isolated profiles
and explicit synthetic peers. Studio sessions, installed model providers and
customer gameplay acceptance were not exercised.
