# Asset start admission

`AssetService.start(input, admission?)` accepts an optional exported
`AssetStartAdmission` supplied by trusted host code:

```ts
interface AssetStartAdmission {
  beforeCreate(): void;
  created(jobId: string): void;
}
```

The seam is separate from `AssetInput`. It is never an HTTP JSON field or a
source of callbacks from asset requests. Existing request validation still rejects
extra admission/callback fields. Calls without admission retain generic behavior.
This change implements no authority registry, lifecycle, conversation host or
HTTP route; those owners must construct their admission from trusted state.

## Ordering and failure

Start first drains the existing queued history flush and performs the open,
busy, reconciliation, history-limit and input checks. It prepares worker options
before invoking `beforeCreate`. The callback and synchronous return validation
immediately precede `pipeline.start`, with no await or other operation in between.
A thrown pre-creation check prevents a pipeline start. Authority revoked while
the history flush is queued is therefore checked at the creation boundary.

After a pipeline handle is returned, start installs its history entry, completion
observer and active cleanup, then invokes `created(handle.id)` exactly once,
before scheduling/awaiting the next history persistence. The callback observes
the actual job UUID; it must bind that UUID to the host's existing owner. It does
not grant additional rights or authorize replay.

Both callbacks must finish synchronously. Returning a Promise or other object or
function with a callable `then` is rejected without awaiting or consuming it.
`beforeCreate` thenables fail with `ADMISSION_ASYNC` before creation. Host code
must not launch asynchronous work in these callbacks; rejecting a returned
thenable cannot undo work the callback already initiated.

If `created` throws or returns a thenable, start reports `ADMISSION_CREATED` with
the actual UUID after draining the required history bookkeeping. The original
callback exception is not propagated as a pre-creation-safe rejection. The job
entry and active supervision remain installed; normal completion, cancellation
and close still update its retained outcome. A callback-only failure does not
automatically cancel or create another job. If history persistence also fails,
the existing cancellation/completion drain runs before reporting the callback
failure. The persistence latch remains observable through subsequent operations.

If `created` succeeds and later persistence fails, its witnessed UUID remains
valid: the existing persistence failure path cancels and awaits the actual job,
retains its journal/outcome and latches the failure. Start rejection alone never
proves that no job was created. Host owners must preserve witnessed IDs, treat
`ADMISSION_CREATED` as post-creation, and never automatically replay.

## Verification and limits

`tests/unit/asset-start-admission.test.ts` exercises the exact service and pipeline
with real temporary journals/index files, filesystem write barriers/faults, an
inert worker root, explicit missing runtime paths and a process double that
rejects every attempted native launch. It covers queued-flush revocation,
synchronous ordering, witnessed creation followed by persistence failure,
throwing witnesses with cancellation/close cleanup, both callbacks' thenable
returns, generic starts and existing input/busy/closed checks. Builtin mocks run
serially in Node's isolated test process.

Use private compiler output with explicit source files when verifying; do not
run the root build or write `dist`. Controlled verification on 2026-10-13 passed
strict TypeScript compilation of the three test entrypoints and their dependencies
into an OS temporary output directory, then **38/38** checks with
`node --test --test-concurrency=1`: 9 admission, 19 existing service-persistence
and 10 existing atomic-writer tests, with zero skips and zero native spawns.

These controlled tests establish service ordering and bookkeeping only. User
Studio and installed Codex/Claude testing
remain deferred. No paid provider, Blender/Studio process, rights relaxation,
automatic replay, antivirus/ACL or Git change is part of this seam.
