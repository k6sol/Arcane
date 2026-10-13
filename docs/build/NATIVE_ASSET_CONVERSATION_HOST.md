# Native asset conversation host

The native methods in `apps/daemon/src/asset-conversation-host.ts` borrow the
existing association store and asset service. They accept the opaque runtime actor
from `native-asset-authority.ts`; JSON, actor clones, caller project fields and
caller conversation fields do not provide authority. This component performs no
provider, native history, Studio or Blender operations and owns neither borrowed
resource. HTTP authentication and native lifecycle wiring belong to the parent.

## Parent contract

```ts
const host = createAssetConversationHost({
  projectPath: associations.projectPath,
  workAssociations: associations,
  conversation: trustedHumanConversation,
  start: async request => (await assets.start(request)).jobId,
  startNative: async (request, admission) =>
    (await assets.start(request, admission)).jobId,
});

const actor = registry.capture(nativeCredential, 'mutate');
const result = await host.startNative(actor, assetInput);
```

`startNative(request: AssetRequest, admission: AssetStartAdmission): Promise<string>`
is an optional trusted host option. `AssetStartAdmission` is imported from
`asset-service.ts`: `beforeCreate(): void` and `created(jobId: string): void`.
The callback must forward this exact admission object into the service. Admission
is synchronous host code and must never be supplied through request JSON. Native
creation without this option fails with `ASSET_CONVERSATION_NATIVE_UNAVAILABLE`;
native reads remain available. There is no fallback to the generic start callback.

The parent must attest the service's exact canonical project. Construction compares
the provided project spelling with the borrowed store exactly. Each native method
calls `assertNativeAssetActor(actor, operation)` and obtains its scope through
`nativeAssetActorScope(actor)`. Both registry project ID and path must match the
borrowed store. No normalization, human/current/saved conversation callback or
later registry recapture substitutes for that scope. The registry handles capture
generation, grant, dispatch window and forged-object refusal.

The returned factory object exposes the original human/generic methods and the
three native methods. The exported `AssetConversationHost` retains the original
structural human/generic interface for existing routes and fixtures;
`NativeAssetConversationHost` describes the native methods. A consumer needing
both can use their intersection or infer the factory result. Existing human and
generic response shapes are unchanged.

## Creation and uncertain acknowledgements

`host.startNative(actor, input)` captures the immutable registry tuple, detaches
and normalizes bounded asset JSON, and validates association storage before the
first await. Storage admission is a validated scoped read, not a capacity
reservation or a transaction with the asset service. The current store exposes
no reservation API, so a later binding capacity failure remains possible.

The service must call `beforeCreate` after its awaited preflight and immediately
before allocation. This callback rechecks the **same** actor for mutation and
checks storage again. Revocation, regrant, dispatch window end/replacement,
retirement or registry closure while queued refuses this admission. A new grant
cannot upgrade an old capture. An observed refusal before any witnessed creation
propagates as a pre-creation error.

The service calls `created(id)` immediately after allocating the job and installing
its supervision. The callback records a witnessed ID and attempts to persist its
original captured binding once, synchronously. It deliberately does not recheck
authority after allocation: revocation, retirement, window end and UI/context
changes cannot move a created job to another conversation or erase its attribution
attempt. A binding failure is contained; the service can finish its own bookkeeping.

The native start result is:

```ts
{
  projectId: string,
  projectPath: string,
  jobId: string | null,
  conversation: NativeConversation,
  association: 'bound' | 'unknown',
  creation: 'created' | 'unknown',
  retry: false,
}
```

Successful witnessed creation and acknowledged binding report `created`/`bound`.
A callback rejection after creation, lost creation witness, invalid/mismatched
returned ID, association conflict/write failure or lost persistence ACK reports
`creation: 'unknown'`, `association: 'unknown'`, `retry: false`, with the witnessed
ID when valid. Without a witness, a valid returned ID may be reported for retained
evidence inspection but is never bound. If no valid ID is known, `jobId` is null.
Callback rejection alone cannot establish that creation did not occur.

The returned conversation in an unknown result describes the original capture;
it does not claim that binding persisted. Error details, foreign conversation
metadata and credentials are not returned. After uncertainty the adapter does
not probe storage, rebind, recreate or replay. Duplicate/out-of-order admission
calls fail or remain unknown; late calls cannot write another association. An
already committed first binding is retained even when a later callback fails.
There is no request idempotency journal: a new explicit invocation is new work,
so an unknown result must not be automatically resubmitted.

## Native reads and page adapter

`host.listNative(actor, pagination = {})` returns the exact captured project,
conversation and stored asset-job page. `host.bindingNative(actor, id)` returns
only an existing asset binding matching that project and all three native fields,
or null. Provider, thread spelling/case and session are exact; null session is a
separate scope, never a wildcard. Reads do not bind, backfill old global jobs,
adopt generic jobs or interpret workflow namespace IDs as assets. Storage validates
pagination, native ID bounds, credentials and its exact scoped cursors.

```ts
const actor = registry.capture(nativeCredential, 'read');
const page = nativeAssetConversationJobPage(assets, host, actor, {
  limit: 32,
  after: null,
});
const binding = host.bindingNative(actor, knownJobId);
```

`nativeAssetConversationJobPage` accepts only the service's `jobs`/`projectPath`
read seam and the host's `listNative` seam. Single-job authorization can separately
use `bindingNative`. The helper compares the borrowed service project exactly and
passes the same actor to every metadata read. It never routes through `listHuman`
or a human binding callback.

Both page entry points share the established captured-page algorithm: complete
matching records in association order, a 1..64 binding count including orphans,
and a 512 KiB UTF-8 JSON envelope including full records and cursor. Foreign jobs
are not serialized. A regular read plus at most one exact prefix read retains
authoritative storage cursors on byte overflow; it never synthesizes a cursor
from job IDs. Prefix scope/binding changes, revocation or failed observations
refuse with `ASSET_CONVERSATION_STALE`. A single record exceeding the byte bound
fails with `HISTORY_LIMIT`. The original human helper remains unchanged at its
public entry point.

## Verification

`tests/unit/native-asset-conversation-host.test.ts` uses real temporary association
SQLite and the real parent registry with explicitly synthetic seal/grant/dispatch
ACKs and service allocation callbacks. It covers forged and cross-project actors,
scope/namespace/cursor separation, read-only captures, queued generation changes,
before/after-allocation context changes, lost creation/persistence ACKs, callback
replay, no old global adoption, restart observation, original human/generic APIs,
complete native pages and UTF-8/cursor limits. Source checks also guard the native
registry and page adapter seams.

Compile the focused suites with the pinned TypeScript compiler into a unique
temporary directory, using the repository strict settings and explicit test
files. Set that temporary package to ESM and resolve its external packages from
the existing repository installation. Run Node's test runner on those temporary
outputs. No shared compile configuration, `dist`, provider process or artifact
worker is required. Temporary SQLite cleanup verifies each owned absolute path
against its temporary boundary before recursive removal.

Verified on 2026-10-13 with Node 24.21.0 and TypeScript 7.0.2: strict compilation
of six explicit test files and their dependency closure succeeded into a unique
temporary output directory. The five host/page/storage suites passed 112 tests;
the existing HTTP suite passed all 16 tests with an in-process ESM resolver hook
pointing external packages at the existing repository installation. Its initial
isolated run failed to locate `zod`; correcting temporary package resolution
required no product change. Final focused evidence is **128 passing tests**:

| Suite | Passed |
| --- | ---: |
| Native asset conversation host | 32 |
| Original asset conversation host | 25 |
| Original captured page | 24 |
| Original page boundary review | 2 |
| Conversation work SQLite store | 29 |
| Original conversation HTTP | 16 |

This establishes component and existing human-route regression coverage. Parent
native HTTP/lifecycle wiring and full-product verification remain separate.
