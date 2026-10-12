# Native conversation history foundation

Status: **API foundation only; future integration is not wired.** Shared native
history is not already working in Arcane. The parent owns exports, transport,
session lifecycle, daemon/service integration, UI, and product build/regression.
This change owns only `packages/codex-client/src/history.ts`,
`tests/unit/codex-history.test.ts`, and this document. It makes no native calls.

## Sources checked on 2026-10-12

- [OpenAI Codex app-server](https://learn.chatgpt.com/docs/app-server): persistent
  thread lifecycle, metadata listing, hydration, item schemas, and experimental
  pagination. Installed generated public schema references were read from
  `packages/codex-client/.protocol/v2` and the named output-content types in
  `.protocol`; authentication, native transcripts, rollouts, token files, and
  desktop databases were not read.
- [Claude Code CLI reference](https://code.claude.com/docs/en/cli-reference):
  UUID `--session-id`, exact-session `--resume`, and print-mode
  `--output-format stream-json` are documented. `--fork-session` creates a
  different native session, so it is excluded from the plan.
- [Claude Code memory](https://code.claude.com/docs/en/memory): instruction files
  and auto-memory notes provide context across sessions. This is file-based
  memory, **not model weight training**. Saved notes do not demonstrate improved
  performance; self-improvement claims need reproducible before/after task
  outcomes, comparable evaluation conditions, and evidence of fewer errors.

The documentation is mutable. Recheck it and the installed public schema before
connecting the planner to native processes.

## Identity and capability planning

`planNativeHistoryCapabilities(input)` is pure: it returns proposed public
requests or argument arrays and does not launch, create, resume, or send turns.
Its `nativeApis` distinguish documented `supported`, `experimental`,
`unsupported`, and `unverified` capabilities. `availableInPlan` means prerequisites
for describing a call were supplied; it is not runtime verification. Every result
has `runtimeVerified: false`, `wiring: 'not-wired'`, and desktop visibility
`{status: 'unverified', requires: 'real-desktop-test'}`.
These flags describe this pure planner and sidebar visibility; they do not negate
the parent-supplied native read-accessibility evidence recorded below. The planner
does not ingest proof records or independently execute/verify its proposed calls.

| Provider contract | Planned behavior |
| --- | --- |
| Codex `thread/start` | Persistent `ephemeral: false`; parent must add its existing selected-model, human-review, and sandbox settings. |
| Codex `thread/list` | Exact workspace, explicit `cli`/`vscode`/`appServer`/`exec` source kinds, OpenAI provider, bounded page size. Parent must preserve opaque cursor pagination and detect repeated cursors/caps. |
| Codex `thread/read` | Exact `threadId`, `includeTurns: true` for legacy records; parser described below. |
| Codex `thread/resume` | Exact native `threadId`; no path, injected history, or fork. Parent owns authorization and lifecycle fencing. |
| Codex `thread/turns/list` | Experimental; plan requires explicit experimental negotiation and matching schema evidence. Describes `itemsView: 'full'` and ascending order. A scoped cursor/page parser and merger are still needed. |
| Claude Code | Caller supplies a UUID; plan describes separate creation/resume argument arrays with `--print --output-format stream-json --verbose`. No Claude stream parser or process adapter is implemented here. |

Current OpenAI documentation says paginated storage creation, full hydration,
resume, and turn pagination fail closed. For `historyMode: 'paginated'`, this
planner reports unsupported and permits metadata inspection only. Turn pagination
of a legacy record is a separate experimental capability. Default summary/notLoaded
turn data cannot establish full history. [App-server reference](https://learn.chatgpt.com/docs/app-server).

An Arcane reference must bind the provider to its exact native conversation ID.
Codex `thread.id` identifies the conversation to resume; `sessionId` can be shared
by a session tree and is not an interchangeable resume ID. The parser preserves
both. Claude Code has its own UUID namespace. Mirroring a native conversation
across Arcane and that provider must retain its ID, rather than create a copied
chat. The two providers do not share a universal native ID. The planner never
invents IDs or executes all of its alternative creation/resume plans.

## Bounded public parser

Direct module imports are available for later parent wiring; no barrel export was
changed. The parser accepts a public legacy `thread/read` result `{thread: ...}`,
an ordinary JSON-RPC response `{id, result: {thread: ...}}`, or serialized JSON.
It requires trusted request provenance and exact expected scope:

```ts
import { parseCodexThreadRead } from '../../packages/codex-client/src/history.js';

const history = parseCodexThreadRead(publicReadResult, {
  threadId: savedExactNativeThreadId,
  cwd: requestedExactWorkspace,
  sessionId: savedNativeSessionTreeId, // Optional additional consistency check.
  includeTurns: true,                 // Must describe the actual public request.
});
// history.entries: [{role: 'user' | 'assistant' | 'tool', text, ids}]
// ids: {threadId, sessionId: string | null, turnId, itemId}
// Keep completeness, gaps, truncated, and marker with the displayed entries.
```

Hard maxima are **2 MiB, 64 turns, 256 inspected items**; callers may only reduce
them (`maxBytes` minimum 1024). Serialized input is checked in UTF-8 before JSON
parsing. Already-decoded objects budget recognized public text and the complete
serialized public result, including JSON escapes and ID/diagnostic overhead;
unknown fields are not traversed to estimate their private payload size. The
transport must independently enforce its frame limit. Text-block arrays are
bounded too. Oversized entries are omitted whole and a truncation marker retained.

The allowlist projects user `content[].text`, assistant `text`, command
`aggregatedOutput`, MCP `result.content[].text`, dynamic `contentItems[].text`
with `inputText`, and function output strings or `input_text` blocks. It never
extracts tool arguments, command strings, `structuredContent`, `_meta`, reasoning
summaries/raw reasoning, encrypted content, or arbitrary nested `text` values.
Known reasoning/plan/internal orchestration kinds are counted as exclusions from
the public projection. Unknown kinds and omitted non-text content produce gaps.
Selected object accessors are rejected without invoking them; ignored private
fields and `toJSON` are never accessed. Array accessors/iterators are not invoked;
unknown assistant phases fail closed before their text is read.

Redaction covers common provider key/token formats, bearer/basic authorization,
credential assignments, URL userinfo, JWTs, 64-digit hexadecimal tokens, and
private-key blocks in the allowed public text. This is defense in depth, not proof
that every arbitrary secret can be recognized. Parent code must keep native
credentials outside public content and never route raw/private payloads into UI
or exports. Sanitized text remains untrusted data: rendering must escape it.

`completeness: 'complete'` means the bounded public projection of the requested
hydrated response has no detected gaps. It does not certify that historical
context survived compaction or that another client has not since changed it.
Scope mismatches, unsupported modes/envelopes, and RPC errors fail closed with no
entries. Missing hydration, malformed turns/items, unhydrated item views,
unfinished/failed turns, compaction, and bounds remain explicit gaps. Identical
items deduplicate by `(turnId, itemId)`; identical text under different IDs stays.
Conflicting duplicates remove both versions and preserve a gap. Duplicate turn
snapshots are not silently merged. Diagnostic retention is bounded, with
`droppedGaps` and a truncation marker preserving evidence of omitted gap details.

This function does not fold streaming deltas. A completed public item snapshot
is authoritative; future streaming integration must use scoped identities,
connection sequence numbers and gap evidence rather than append/replay deltas
onto hydrated text. Raw notifications and turn-page shapes are rejected by this
legacy-read parser.

## Verification and remaining product work

**Native read accessibility is verified for one existing persistent Codex
conversation.** On 2026-10-12 the parent supplied authoritative read-only evidence:
`mcp__codex_app__read_thread` succeeded with schema 1 for the exact previously
created Arcane CLI smoke thread `01a12dc9-c3de-7ba2-bff7-677013eb6059`. The response
identified a local Codex thread in the temporary Arcane smoke workspace and its
completed turn `01a12dc9-c9a0-7181-883e-743f352fff97`, with public user text,
assistant commentary, a completed MCP `work_runs` call, and assistant final text
`ARCANE_SMOKE_OK`. The desktop connector can therefore read that same persistent
native thread; datastore/history accessibility is established for this existing
one-turn case. No new model turn was run to obtain the read evidence.

This is parent-supplied evidence, not a native test executed by this worker or a
result from this parser. The parent will persist a redacted proof JSON containing
native IDs, status, and public item types, without raw reasoning or credentials;
this document does not claim that artifact has already been saved.

**Codex sidebar listing, live UI registration, and concurrent two-client
resume/full synchronization remain unverified.** Neither this successful read nor the
cited documentation nor CLI `thread/start` establishes automatic app sidebar
registration. A real desktop test must verify discoverability, the same native
thread ID, and history continuity after restart/resume. No desktop database edits
or `create_thread` calls are an acceptable substitute.

**Full Claude web history, claude.ai synchronization, and Claude Design sync are
unverified.** The Claude Code CLI contract does not establish any such supported
API. Its exact-session CLI resume capability is distinct from web history.

Tests use fixed synthetic public-schema fixtures, including unsupported paginated
records, exact scope checks, duplicate/conflicting items, deltas, credential
redaction, byte/count bounds, omissions, malformed objects, and private-field
access guards. They do not inspect real private transcripts or exercise native
creation, resume, model turns, or processes.

The parent still needs public RPC wrappers, trusted identity persistence, scoped
cursor/page handling, live-event reconciliation, Claude stream parsing, safe UI
rendering/export, desktop verification, and product regressions. Passing these
foundation tests does **not** mean shared history is complete end to end.
