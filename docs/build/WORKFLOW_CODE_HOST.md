# Production Luau verification host

Arcane can now run the implemented official Luau checker through its actual workflow
host, rather than only injecting it in a component test. This is syntax evidence,
**not** type, regression, gameplay-security or complete production approval.

## Configure the trusted local launcher

The command-line product launcher supports one explicit immutable tuple:

- `ARCANE_LUAU_COMPILER_PATH`: absolute, direct installed `luau-compile` path.
- `ARCANE_LUAU_COMPILER_SHA256`: trusted official-release SHA-256, lowercase.
- `ARCANE_LUAU_EVIDENCE_DIRECTORY`: existing project-relative report directory.

Supply all three or none. Invalid/incomplete tuples fail before opening stores.
The host attests compiler provenance; matching its help text does not establish trust.
The adapter independently pins binary bytes, physical ancestors and project identity.
There is no PATH fallback, downloaded replacement, arbitrary compiler flag, source
execution, automatic directory creation, provider command or Studio operation.

Without configuration no compiler is started, and verification stays unavailable.
The evidence directory must be covered by the reviewed workflow scope and cannot
contain the input source files. Supported subjects are the complete set of 1–16
implementation `.luau`/`.lua` patch artifacts, not a diff or arbitrary executable.

**Desktop source implementation:** Electron still drops inherited Arcane
configuration. The new [native desktop setup](DESKTOP_CODE_VERIFICATION.md) saves a
project-scoped host-owned tuple and supplies only validated compiler settings at
the next daemon start. Saving does not execute verification or restart active work.
The previously sealed pxvwBu portable EXE does not contain this setup addition;
a fresh compile, bundle and actual launch check remain required.

## Real route and lifecycle

`POST /v1/workflows/verify-safe` accepts only:

```json
{"workflowId":"known-workflow","stepKey":"verification","idempotencyKey":"fresh-opaque-request"}
```

The exact human bearer/origin/raw-header/body guards apply. Agent bearers cannot
invoke it. Project/native-conversation attribution comes from trusted host state,
not the request. It checks exact attribution before and after the awaited operation.
Native-chat changes never receive another chat's output or create a new association.
The old unimplemented `/verify`, `/launch` and `/studio` endpoints remain unavailable.

The coordinator requires a ready registered verifier, actual accepted source pins,
reviewed dependencies and the bounded attempt policy. The registration captures its
callbacks and observes `available()` dynamically: only synchronous boolean `true`
permits dispatch. False, thrown, promise and truthy nonboolean values deny. A browser
or policy-context capability label cannot override this observation. Compiler faults
invalidate the real adapter; they do not leave a synthetic available registration.

An exact duplicate observes its durable command result; it never reruns the compiler.
Only a pre-execution busy source read with unchanged subjects may be retried through
a new explicit human request within the recipe bounds. Unsupported/terminal/unknown
outcomes do not permit replay. An uncertain returned operation is HTTP 202; explicit
inspection/reconciliation is required. Report files remain unique and hash-pinned.

The host drains its one owned async verifier before closing journals and native
associations. It quiesces new opens immediately. Synchronous busy-close refusal
retains ownership so an asynchronous drain is still possible. Borrowed WorkStore
and project files are never closed or rewritten by the host.

## Manual implementation handoff

Production advertises `local.patch` with safety `human-handoff`, not an automatic
patch executor. Existing scoped file-evidence preparation, exact signed previews,
local-write gate, submission and review routes can record actual human/native-authored
source. They do not execute code, expand file scopes or claim a patch was applied.
The human must separately authorize any native edits in the existing chat.

Successful syntax compilation produces a submitted report. Unimplemented combined
syntax/type, regression, scope-diff and security checks stay unsupported, so workflow
quality/release remains pending even with a human approval request. Never label this
partial evidence as a completed game or a fully verified code change.

## Verification records

- `workflow-code-host.test.ts`: launcher parsing and actual production route guards;
  opt-in official-compiler case exercises owned project files and real HTTP-to-Luau.
- `workflow-verifier-availability.test.ts`: real SQLite with explicitly synthetic
  receipt/catalogue observations, dynamic denial and captured callbacks.
- Original full compiled regression: 922 tests, 910 passed, 2 HTTP fixture timeouts,
  10 explicit skips. Both original failures passed a separate isolated check with
  their unchanged 8-second timeout. This does not establish a green broad suite.

No real provider turn, native Studio operation, publishing or uploads are part of
these checks. The multi-step official host fixture has a 300-second total test budget;
individual HTTP, compiler, cleanup and native ACL deadlines are not relaxed. Its
original 120-second total-budget cancellation is retained as failed evidence.

## Windows assessment performance and retained failures

The first real host integration cancelled at its120-second total fixture budget.
After reusing returned snapshots, an individual15-second HTTP deadline still
expired on a later action. Safe method/path/status/timing diagnostics showed
execution growing from about3seconds to5.6,7.7 and9.8seconds as approvals accumulated.
These original failures are retained in the isolated code-host verification folders.
They were not reclassified as successful compiler or production acceptance.

A synchronous assessment now brackets all approval MACs with the unchanged complete
native ACL check. Each MAC still reopens and checks the direct single-link key,
physical ancestors, descriptor/path identity, size/timestamps and exact32key bytes.
A final complete permission/key check must succeed before the assessment returns.
No validation is cached across requests, events or awaited compiler operations.
Signing/direct human authorization still uses its normal complete native check.
The native checker has the same5000ms limit and all existing ancestor/owner/DACL
rules; no existing ACL or antivirus setting is changed. Actual production HTTP-to-official-compiler acceptance passed afterward: one
complete multi-step test with38owned HTTP requests, including a6993ms verification
request, intact compiler/source/report pins and blocked unsupported quality.
Five independent native-boundary tests also passed: post-check failure, per-request
freshness, direct-command checks and transient key mutation fail closed. These
boundary tests are explicitly native ACL doubles after real private preparation.


## Existing-receipt cold start

The existing key constructor no longer repeats a directory-only native ACL process immediately before its full directory/key/ancestor check. No existing key bytes or content are read first: read() performs the unchanged full native check before opening the key, then its original regular-file identity/byte pins. New private directories still require exact native preparation and the post-creation full check. Read/write counts now require bounded integer progress, preserving partial files on failure without repair or regeneration. Parent original handoff/review/restart fixture passed afterward with unchanged8000ms HTTP and5000ms native limits. Exact-source boundary doubles passed23tests/179scenarios. A full desktop pipeline is running separately; these results are not a green broad regression or native Studio/provider acceptance.
