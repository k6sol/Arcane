# Per-task usage contract — 2026-10-13

Owned implementation: `packages/codex-client/src/types.ts`, actual SDK implementation `packages/codex-client/src/session.ts` (there is no `client.ts`), `apps/desktop/src/task-usage.ts`, and the focused `tests/unit/task-usage.test.ts` / `tests/unit/codex-token-usage.test.ts`. Chat UI, HTML, CSS, Studio and daemon files are owned by the other workers and are not edited by this worker.

## Native evidence and limits

Read the existing captured native schema at `C:/Users/alexk/AppData/Local/Temp/arcane-codex-history-schema-de689a92-3ae5-4971-a901-5ccc83547267`, specifically `v2/ThreadTokenUsageUpdatedNotification.ts`, `v2/ThreadTokenUsage.ts`, `v2/TokenUsageBreakdown.ts`, `v2/Turn.ts`, and the notification method in `ServerNotification.ts`. This is existing metadata, not a newly invoked CLI or a native trace from a new model turn. No account/auth file was read. The captured schema does not establish the version of a future installed CLI.

The parent subsequently supplied the current native evidence at `runtime/verification/skill-evaluation-eight-turns-20261013/protocol/v2/`. Read its three token-usage schema files and only whitelisted usage counters/scope-key names from `outputs/slot-1.json` through `slot-8.json`. The current schemas match the earlier capture. All eight captured usage payloads validate; thread totals range from 13,686 to 15,248 tokens, while the corresponding last-request totals range from 6,989 to 7,851. The focused SDK test preserves each exact counter, including actual reported cached input and reasoning output, using sanitized numeric fixtures with synthetic test identities. This is read-only reuse of the parent's already authorized eight native evaluations; no new inference was launched and no fixture execution or skill benefit is claimed by this telemetry work.

The native notification is `thread/tokenUsage/updated` with `{threadId, turnId, tokenUsage: {total, last, modelContextWindow}}`. Counts include `totalTokens`, `inputTokens`, `cachedInputTokens`, `cacheWriteInputTokens`, `outputTokens`, `reasoningOutputTokens`. `Turn.durationMs` is explicitly reported duration in milliseconds; wall timestamps are not used to invent elapsed time.

Cross-checked the [official app-server events documentation](https://learn.chatgpt.com/docs/app-server#turn-events) and [OpenAI's generated notification](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/schema/typescript/v2/ThreadTokenUsageUpdatedNotification.ts), [thread usage](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/schema/typescript/v2/ThreadTokenUsage.ts), and [count breakdown](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/schema/typescript/v2/TokenUsageBreakdown.ts) sources. The local capture is the primary implementation evidence. `last` is preserved as last-reported-request usage, never treated as a complete human task. The inspected notification and turn schema have **no vendor-reported monetary cost** and **no explicit turn token total**. Actual charges and native per-turn totals remain unsupported. No undocumented `turn/tokenUsage/updated`, response usage aliases, account-usage queries or account-status commands are added.

## Minimal parent / chat-worker contract

SDK additions are optional and preserve old snapshots/events:

```ts
Snapshot.usage?: TokenUsageReport
// {source:'thread/tokenUsage/updated', threadId, turnId, seq,
//  total, last, modelContextWindow, continuity:'reported'|'uncertain'}
SessionEventValue |= {type:'usage', threadId, turnId, usage:NativeTokenUsage}
ThreadState.durationMs?: number
// Existing type:'turn' events also accept optional durationMs.
```

`seq` remains the existing per-connection cursor. SDK keeps a defensive copy of the latest report even if the bounded event ring evicts its event. Usage cannot adopt a thread/turn or start/revive a task. It is accepted only on the connected exact current thread and turn, including late final usage for that current terminal turn. Stale previous-turn notifications are ignored. Identical reports do not create a second usage event. Valid cumulative decreases mark continuity uncertain; subsequent values cannot silently repair that connection's continuity. Invalid optional telemetry is discarded without terminating a real lifecycle.

**Frozen frontend validation handoff for Faraday:** import `readTaskUsage` from `./task-usage.js`; it accepts both a snapshot report and an event's nested `usage` as `unknown` and returns sanitized `NativeTokenUsage | null`. Accept old snapshots with the `usage` key absent. When it is present, require a valid helper result plus own bounded nonempty `threadId`/`turnId`, a positive safe-integer `seq <= lastEventSeq`, and a thread matching the current SDK thread. Preserve only the normalized helper result and these three envelope fields. `Snapshot.usage.turnId` may identify the preceding turn while a new turn is starting: do not reject the entire snapshot for that mismatch. The tracker checks exact current-task attribution before applying it. Never promote that preceding report to a new task or rewrite its ID.

Add `type:'usage'` to the supported event union, validate its outer exact thread/turn IDs and existing sequence bounds, and validate/sanitize its nested `usage` with the same helper. Add optional `durationMs` to the existing thread and turn-event shapes only: it must be a nonnegative safe integer at most `31_536_000_000` milliseconds. Missing duration stays absent. The only allowed continuity values are `reported` and `uncertain`, and source is exactly `thread/tokenUsage/updated`; no cost, auth, provider, model alias, unscoped token count or alternate native method is part of this contract. SDK/schema fields are frozen for the parent global compile; this worker does not edit CodexChat's decoder or the parent boot/DOM files.

The standalone browser module uses type-only imports, so it needs no SDK runtime URL. Faraday's chat controller can export this bridge:

```ts
subscribeReadonlyTaskState(listener: (state: ReadonlyTaskUsageState) => void): () => void
// state = {projectId, snapshot, liveTurnId?}
```

The actual finalized Faraday hooks are `CodexChat.currentStateView()` and `CodexChat.subscribeStateChange(listener:()=>void)`. `currentStateView()` returns a **wrapper**, with the canonical `ChatState` under `.state`, plus `fresh`, `switching`, and `nativeBoundToActiveChat` guards. There is no direct `.snapshot` on that wrapper. Parent can use the adapter below instead of adding another chat-worker export; the standalone `SubscribeReadonlyTaskState` type remains an optional adapter signature.

`projectId` must be the exact trusted host project identity; the existing exact `ChatState.projectPath` is acceptable if that is the parent's canonical identity. Do not normalize, lowercase, use a display name, or fall back to another project. Publish only validated current `snapshot`, never reinterpret `lastSnapshot` as an active connection. `liveTurnId` is optional and must come only from the live human turn-start hook for that exact native turn. Do not set it on resume/restoration; absent evidence is labelled **Observed elapsed**. Do not attach provider/auth objects, API keys, or arbitrary logs to this bridge. `readTaskUsage` revalidates and whitelists optional usage at the browser boundary, without invoking getters.

Parent owns `/task-usage.js`, Studio boot integration, subscription/timer disposal, and binding to Bernoulli's HTML footer `#codex-task-usage`; Faraday owns CodexChat and chat-tabs. Example parent binding:

```ts
import { TaskUsageTracker, type ReadonlyTaskUsageState } from './task-usage.js';
const tracker = new TaskUsageTracker(); // performance.now()
let latest: ReadonlyTaskUsageState = {projectId: '', snapshot: null};
function feed() {
  const view = chat.currentStateView();
  latest = {
    projectId: view.state?.projectPath ?? '',
    snapshot: view.fresh && !view.switching && view.nativeBoundToActiveChat
      ? view.state?.snapshot ?? null : null,
  };
  // Add liveTurnId only from Faraday's explicit acknowledged human-start hook.
  // Do not infer it from restored action records or snapshot turn/status.
  paint();
}
const unsubscribe = chat.subscribeStateChange(feed);
feed();
function paint() {
  const view = tracker.read(latest);
  footer.hidden = !view.footer.visible;
  footer.textContent = view.footer.text;
  footer.setAttribute('aria-label', view.footer.accessibleLabel);
  footer.title = view.footer.detail;
}
// While the returned view is active, repaint at a modest interval.
// Reuse cached `latest` for ticks rather than cloning all chat state each tick.
// On disconnect/clear/unmount: publish snapshot:null, tracker.clear(),
// unsubscribe(), and dispose the timer. The module creates no HTML or timer.
```

HTML worker supplies a compact footer with accessible `role="status"`, `aria-live="polite"`, `aria-atomic="true"`, initially `hidden`. Parent can avoid announcing each elapsed tick by applying live announcements only to changed token/status values. Footer appears only for an active task or a reliable token/time measurement. Missing tokens are **Tokens pending** during activity, **Task tokens unavailable** after an uncertain terminal outcome, never a fabricated zero. A thread total is always explicitly **Thread total**, never labelled current task tokens.

When no reliable task total exists but exact-turn request usage does, the compact text says **Last reported tokens … (request)**. Thread cumulative counts are separately labelled in accessible/detail text, keeping the footer compact. When no pricing configuration exists and no subscription inclusion was actually reported, the compact footer omits the cost field; the structured cost state is still `kind:'unavailable'`, `label:'Estimate unavailable'` for callers that need an explicit unavailable indicator. Parent should run one modest timer only while `view.active` is true, and stop it on terminal/unknown/clear/disconnect/close. The module owns no timer or DOM and performs no native operation on a tick.

## Projection, clock and cost

The module scopes ledgers by exact `(projectId, connectionId, threadId)` and records by exact turn ID. Retention is bounded (128 ledgers, up to 128 task records per ledger); there is no persistence or cross-connection subtraction. A fresh acknowledged `thread/start` with intact evidence permits the first task's thread counts to become task counts. Later tasks require a reliable previous terminal baseline; resumed tasks without one expose thread counts only. Gaps, reset/decrease, malformed counts, ambiguous baselines and stale reports cannot become negative or invented task totals. Returned objects are defensive copies.

Elapsed is measured by an injectable monotonic clock; defaults to `performance.now()`. Cancellation acknowledgement keeps it running until real terminal state. Completed/failed/interrupted tasks seal the clock, and stale active snapshots cannot resurrect it. Explicit unknown/disconnected state freezes the measured segment; same-cursor stale active state cannot resume it. Restored active tasks and observation gaps are labelled **Observed elapsed**. A completed native `durationMs`, if present and bounded, can provide **Reported elapsed** after restoration. No `Date.now()`, inferred wall-time duration, native duration invention, percentage or account spend calculation is used.

Default cost is **Included in plan** only when the current validated snapshot reports `account.auth:'subscription'`; otherwise **Estimate unavailable**. No `$0 billed` claim is made. The native protocol has no actual task charge field. There is deliberately no default price or model alias table.

Verified current `protocol/v2/Account.ts`: native account variants are `type:'chatgpt'` with `planType`, `type:'apiKey'`, and `type:'amazonBedrock'`. Existing `CodexSession.#readAccount` maps only native `chatgpt` to `auth:'subscription'`, null to `signed-out`, and the other variants to `unsupported`; it does not pass email or credentials into the usage view. This worker did not invoke that method against a real account or inspect authentication files.

Optional `TaskUsageRateCard` must explicitly authorize its exact project/connection/thread/turn scope and exact configured model, currency, pinned input/output rates and provenance `{id, asOf}`. Estimates use reliable current-task counts only and say **Estimate … (API equivalent)**, including when displayed alongside plan inclusion. These rates represent the explicitly configured model; the protocol usage update does not prove a provider billing model or an invoice. Cached input is subtracted from ordinary input and uses a separate rate only with reported cache counts and applicable configuration. Cache writes need their reported count/rate, or the host's explicit `missingCacheWrite:'not-applicable'` assertion for older protocols. Reasoning output is a subset of output and is not charged again. Missing configuration/counts, changed model, invalid rates or wrong scope yield no estimate. Provenance IDs, model/provider names, arbitrary native fields and credentials are not rendered in the footer.

## Verification

The SDK tests spawn only `process.execPath` with a synthetic peer, not Codex. They exercise native method whitelisting, exact scope, dedup, malformed optional fields, defensive copies, duration and cumulative continuity. No installed CLI, inference, provider mutation, Studio, Git operation, or install is used. Parent still owns UI subscription/HTML/static-route/browser acceptance; this worker's tests do not claim those hooks are connected or native inference acceptance.

Final verification: **62/62** tests passed: 26 pure task-usage tests, seven SDK usage/parser/native-counter-fixture tests, and 29 existing exact-session-identity regressions. **102/102** existing `codex-client.test.ts` fixture regressions also passed. Full `node scripts/compile-product.mjs --noEmit` passed with **165 explicit product sources**. A transient concurrent chat-worker test compile error was resolved by that worker; no other worker's source/test file was edited here.

Final isolated compiler config, compiled tests and retained result log are at `runtime/verification/task-usage-20261013-final-uP95et/`; the complete result log is `test-results.txt`. The final isolated compile and test run include the same-cursor old-turn guard, pending-turn identity, unavailable initial clock, compact exact-turn request fallback and hidden unconfigured cost. Production sources and this scope's tests compile into this unique output directory rather than overwriting shared `dist`.

Current native evidence schema SHA-256 values (read-only):

| Schema file | SHA-256 |
| --- | --- |
| ThreadTokenUsageUpdatedNotification.ts | 53CE4421D686B8A7F9A86C5AD54DE2A7DCEECFB95DF74FA5F441947E136F063D |
| ThreadTokenUsage.ts | 27CAE6C3E6C44696225E9A0903E0531C6EFF126C6DE3DA2176BC5CDD904DEF4E |
| TokenUsageBreakdown.ts | E983F21175FDFDF1A239E26CD8916E1CB765BC0CB7904E2BD9CC83FFE325C8A7 |
