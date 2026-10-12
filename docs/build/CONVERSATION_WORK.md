# Conversation to work associations

`packages/storage/src/conversation-work-store.ts` stores host-attested associations in
Arcane-owned `conversation-work.sqlite`. It stores only canonical project hash/path,
work namespace/ID, native provider/thread/session IDs and an internal ordering sequence.
There are no prompts, tokens, transcripts, provider files or native execution dependencies.

## Host API

```ts
const associations = new ConversationWorkStore({ directory: projectStateDirectory, projectPath });
const conversation: NativeConversation = {
  provider: 'codex', // or 'claude-code'; this is not the model provider alias 'claude'
  threadId: exactNativeThreadId,
  sessionId: exactNativeSessionIdOrNull,
};
const association = associations.bind({ conversation, kind: 'workflow', id: workflowInstanceId });
const existing = associations.binding('workflow', workflowInstanceId); // binding or null
const page = associations.list(conversation, undefined, { limit: 100 });
const next = page.nextCursor === null ? null :
  associations.list(conversation, undefined, { limit: 100, after: page.nextCursor });
associations.close();
```

`bind` returns `{ projectId, conversation, kind, id }`. `binding` returns that same shape
or `null`; `list` returns `{ items, nextCursor }`. `projectId` and `projectPath` are
read-only canonical identity accessors. Database and state-path fields are private.
The only host operations are `bind`, `binding`, `list` and idempotent `close`.

A work identity is `(kind, id)` within this fixed project. Supported kinds are
`workflow` and `asset-job`, each with IDs of 1..64 ASCII letters, digits, underscores
or hyphens. Use the durable workflow **instance ID**, not its recipe ID, and the durable
asset job ID. Identical binding replay succeeds and returns the original metadata.
Any different provider, thread or session conflicts; `null` is an exact session value,
not a wildcard. Case is significant for native/work IDs. The two namespaces may use
the same ID. There is no unbind, reassignment, deletion, native ID minting or inference.

Native IDs use the existing opaque native-history syntax: an ASCII letter/digit followed
by ASCII letters/digits or `._:-`, at most 256 bytes/characters. They are stored exactly,
without trimming, normalization or case folding. Empty, omitted and credential-shaped
IDs fail. `sessionId` must explicitly be a valid native ID or `null`. All metadata
objects reject unknown/missing fields, symbols, accessors and inherited/custom objects.
No input value is echoed in storage errors and the store performs no logging.

The trusted host supplies conversation identity from its verified native context.
Browser/agent claims alone cannot authorize attribution. When native Codex context is
absent, leave the work item unbound. Do not invent a native identity, associate old or
draft work automatically, fork/resume a conversation, or inspect provider storage.
Absence of a binding means absence of attribution, not a fallback conversation.

For a conversation-scoped host read, obtain `binding(kind, id)` and compare its
`projectId` and all three native fields with the verified current context before
returning the parent-owned workflow/job record. `list` already filters all three fields
exactly. Bindings do not prove the existence, ownership or completion of a work record;
the parent host must validate those through its own stores. Route/runtime integration
and work creation remain parent-owned.

## Commit boundary and recovery

Each `bind` uses one SQLite `BEGIN IMMEDIATE` transaction, including project/schema
validation, conflict detection, capacity checks and insertion. The database uses WAL,
FULL synchronous durability and a unique `(kind, work_id)` constraint. Multiple host
connections serialize writes; identical concurrent replays are safe and conflicts do
not overwrite existing associations. Read validation and retrieval share one snapshot.

Work creation and association live in separate databases and cannot commit atomically.
If work creation succeeds and association fails, or a response/commit outcome is lost,
the parent must preserve the known work ID and report **unknown** attribution/outcome.
Never blindly recreate work, attribute it to the current conversation, or claim the
association failed to commit merely because the caller saw an error. Observe the exact
existing work record and `binding(kind, id)` before explicit reconciliation. Only an
observed identical association justifies replaying that same binding; a conflicting
association must remain a conflict. This store cannot journal the parent's create call.

## Storage validation and bounds

Project and state paths must be bounded absolute local direct directories. Filesystem
roots, traversal, UNC/device/ambiguous Windows paths, symlinks/junctions, redirected
ancestors and private provider/config path segments fail before database access.
Private segments include `.codex`, `.claude`, `.git`, `.agents`, `.aws`, `.azure`, `.ssh`,
`.gnupg`, `.env` and `.env.*`. Arcane's own `.arcane` directory is permitted.
The canonical physical project path and its SHA-256 identity are pinned together;
Windows path hashing folds case, matching existing project identities. Foreign projects
fail, including when the stored hash matches but the stored path does not.

Main database, WAL, SHM and rollback-journal files must be direct single-link regular
files, individually at most 32 MiB. Paths and the main file's inode/device are rechecked
on each operation. New directories/files use POSIX modes 0700/0600 where supported;
Windows permissions inherit from the selected host state directory. Path validation is
cooperative protection, not an OS sandbox against malicious local filesystem races.

Schema version 1 and the Arcane application ID are required. Only a completely empty
version-0 database with application ID zero is initialized, atomically. Future versions,
unversioned nonempty databases, wrong application IDs, unexpected/missing tables,
indexes/triggers, invalid metadata and corrupt records fail closed without reset,
repair or migration downgrade. Reopening never backfills associations. Every operation
revalidates the schema, project and stored metadata before returning or mutating data.

Hard bounds are 4,096 bindings, 2 KiB per stored metadata row, 8 MiB aggregate metadata,
100 items per page and 512 KiB for the entire serialized page. SQL count/byte checks
precede materializing persisted rows. Enumeration is in ascending insertion sequence;
new insertions appear on later pages. Cursors are bounded and scoped to the project,
exact provider/thread/session tuple and optional kind. Reuse under another scope fails.
No pruning occurs; reaching capacity fails explicitly, while identical replays succeed.

Errors use `CONVERSATION_WORK_` with `INPUT`, `PATH`, `PROJECT`, `MIGRATION`, `CORRUPT`,
`CAPACITY`, `CONFLICT` or `CLOSED`. Storage failures never contain raw native data.

## Focused verification

`tests/unit/conversation-work-store.test.ts` uses temporary projects and real Arcane
SQLite files with synthetic metadata. Compile only this test and its dependency closure
into unique temporary output, then run Node's test runner on the emitted test. Shared
build/package output is unnecessary. Native model calls, Studio, provider files,
authentication, configuration and security integration are outside this store.

The focused Windows verification used Node 24.21.0, the repository's strict TypeScript
options and an explicit test file list with only three emitted files: this test, the
store and the protocol error dependency. Compiler exit status was 0; Node's runner
reported **26 tests passed, 0 failed, 0 skipped**. Coverage includes simultaneous
SQLite writers, restart/migrations, project/provider/thread/session separation,
replay/conflicts, bounded pagination, corrupt schemas/rows, links, private paths,
unsafe roots and accessor/proxy rejection.

To reproduce, create a unique temporary config extending the repository `tsconfig.json`,
set `files` to the absolute path of this test, `include`/`exclude` to empty arrays,
`rootDir` to the repository, `outDir` to that temporary directory's `out`, and
`typeRoots` to the repository `node_modules/@types`. Set `noEmitOnError: true`,
`sourceMap: false` and `inlineSources: false`, and put `{"type":"module"}` in the
temporary directory's `package.json`. Then run:

```text
node node_modules/typescript/bin/tsc -p <temporary-directory>/tsconfig.json
node --test <temporary-directory>/out/tests/unit/conversation-work-store.test.js
```
