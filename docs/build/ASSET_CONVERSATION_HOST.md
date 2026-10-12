# Asset conversation host adapter

`apps/daemon/src/asset-conversation-host.ts` is a host-only callback adapter over
the existing `ConversationWorkStore`. It adds asset-job binding and scoped metadata
reads without changing asset services, routes or frontend code. The authorized
storage hardening uses explicit length/allowed-character checks for work/native
IDs; accepted syntax, credential restrictions and storage policies are unchanged. Parent
integration is still required. The adapter performs no CLI, Studio or provider
calls and never opens or closes the borrowed store/service.

## Parent integration seam

```ts
const host = createAssetConversationHost({
  projectPath: canonicalProjectPath,
  workAssociations: associations,
  conversation: trustedLiveNativeConversation,
  start: async request => (await assets.start(request)).jobId,
});
```

The parent must attest that `assets` operates in this exact canonical project.
`projectPath` must equal `associations.projectPath` exactly; the adapter does not
resolve, trim or case-fold a supplied path into authority. Each host captures its
callbacks, store and project at construction. Project switches require the parent
to select the corresponding host/store/service.

After authenticating a human caller, use `startHuman(input)`,
`listHuman(pagination)` or `bindingHuman(jobId)`. Only trusted host code selects
these methods. Never select a method using a client role/boolean, and never derive
the `conversation` callback from browser/agent metadata. Parent HTTP authentication,
body deadlines, response delivery and display of the returned conversation remain
parent responsibilities. An agent bearer must not reach the human read methods.

For an authenticated agent start, use `startAgent(input)`. It returns
`association: 'unscoped'` and `conversation: null` without invoking the conversation
callback or reading/writing association storage. The existing daemon bearer cannot
attest a native conversation.

Keep standalone/global admin starts and listings separate from these conversation
methods. The planned parent `/v1/assets/conversation-start` and
`/v1/assets/conversation-jobs` endpoints can require a live native conversation
without changing existing explicitly unscoped `/start` and `/jobs` behavior.

Both start methods accept bounded asset JSON only, detach it and use the existing
pure asset normalizer. Extra conversation, project or authority fields fail.
Accessors, proxies, hidden/inherited fields, non-JSON values and sparse arrays fail
before evaluation. Bounds follow existing asset JSON constraints: 256 KiB, depth
12 and 100,000 nodes. Native/work identity and credential restrictions are enforced
by existing conversation storage before human creation; work IDs remain 1..64 ASCII
letters, digits, underscores or hyphens. No prompt/transcript/request is persisted
in association storage.

Work/native IDs and callback job IDs scan the whole string for disallowed
characters, rather than relying on a regex end anchor. All C0/C1 controls and
Unicode line separators are rejected at every position. Native IDs still require
a leading ASCII letter/digit, a maximum of 256 characters and the same credential
refusals. No valid syntax has been removed or relaxed.

## Creation and uncertain outcomes

`startHuman` snapshots the exact live provider/thread/session tuple once, validates
it against storage, then invokes `start` once. Missing native context fails before
creation. A pending start retains that detached snapshot if the live chat changes
or disappears. `null` session is exact, not a wildcard.

The result includes `projectId`, `projectPath`, the created `jobId`, `conversation`,
`association` and `retry: false`. Successful binding is `bound`. Any binding failure,
including conflict, closed storage or an error after commit, returns the known job
ID with `association: 'unknown'`. Its conversation is the attempted pre-start host
snapshot, not proof that association persisted. The adapter never probes after a
binding failure, retries binding, recreates a job or attributes it to a later chat.

The start callback must return the durable created job ID. A callback rejection is
propagated without binding or retry. If the callback fails after creating work but
before returning its ID, the adapter cannot recover that ID: the parent must inspect
its own retained service journal. Every explicit start invocation calls the callback;
there is no creation idempotency journal here. Do not resubmit an uncertain start.

## Reads and attribution

`listHuman` returns `{ projectId, projectPath, conversation, items, nextCursor }`.
Items are the store's asset-job bindings, scoped to one trusted live conversation
snapshot. Storage cursors retain the exact project/provider/thread/session/namespace
scope; limits are 1..100 items and the storage page byte bound is 512 KiB. There is
no global asset count, scan or fallback listing.

`bindingHuman(jobId)` returns the existing binding only when its project and all
three native fields match that snapshot. Foreign, absent and workflow-only bindings
return `null`. Missing live context or invalid input/storage fails closed. Returned
binding identities are stored identities; later mutable chat context never replaces
them. Reads never bind, backfill legacy jobs or start work.

The parent may hydrate these scoped IDs through its attested project asset service.
Bindings alone do not prove a job's existence, completion or artifact validity.
Retain the returned project/conversation attestation while fetching and presenting
job data; do not substitute a later current chat to claim attribution.

## Focused verification

`tests/unit/asset-conversation-host.test.ts` uses temporary real association SQLite
and synthetic host/start callbacks. It covers exact scoping, restart, pending/concurrent
starts, before/after-commit uncertainty, agent/legacy isolation, credential and metadata
bounds, hostile descriptors, custom assembly normalization and scoped pagination.
`tests/unit/conversation-work-store.test.ts` supplies the existing storage regressions.
These tests do not establish route/UI integration or run actual asset/provider work.

Compile just those two test files and their dependency closure using a unique
temporary config extending the repository `tsconfig.json`. Override `files` with
their absolute paths, clear `include`/`exclude`, set `rootDir` to the repository,
`outDir` to `<temporary>/out`, and `typeRoots` to the repository's
`node_modules/@types`. Set `noEmitOnError: true`, `sourceMap: false` and
`inlineSources: false`. Put `{"type":"module"}` in `<temporary>/package.json`.

```text
node node_modules/typescript/bin/tsc -p <temporary>/tsconfig.json
node --test --test-concurrency=1 <temporary>/out/tests/unit/asset-conversation-host.test.js <temporary>/out/tests/unit/conversation-work-store.test.js
```

No shared `dist` build is needed.

Verified on 2026-10-12 with Node 24.21.0 and TypeScript 7.0.2: strict compilation
of the two explicit test files and their dependency closure succeeded into a unique
temporary output directory. The final hardened adapter suite passed **25/25** and
the storage suite passed **29/29**: **54 tests passed, 0 failed, 0 skipped** in one
fresh focused run. A test-only correction moved the present-but-undefined `sessionId` case from
the adapter shape-error expectation to the delegated `CONVERSATION_WORK_INPUT`
expectation. No implementation change was needed for that refusal.

Direct Node 24.21.0 checks of the original non-multiline native/work/host ID
expressions returned `false` for trailing LF, CR, CRLF, U+2028, U+2029, NUL,
DEL and U+0085. The reported earlier failure was an error-code expectation for
an explicitly present `sessionId: undefined`, not a demonstrated accepted newline.
The subsequently authorized hardening removes reliance on the end anchor anyway
and expands tests to every C0/C1 control, persisted corrupt IDs, both credential
fields and unchanged valid syntax/length boundaries.

Separate pure checks confirmed normalized `schemaVersion: 1` requests for hero-prop
and custom-assembly are accepted unchanged by `normalizeRequest`, including after
a JSON roundtrip. Thus the ID-only start callback is compatible with
`assets.start(request)`; subsequent parent snapshot retrieval can use `service.jobs()`.
The five owned files also passed whitespace/conflict-marker checks. This
verification used no shared output, actual worker/provider turns, commits or pushes.
