# Codex history UI integration

`apps/desktop/src/codex-history.ts` is a browser-only controller for the daemon’s single current recorded project-bound native Codex thread. It follows Gauss’s stable contract in [CODEX_HISTORY_SERVICE.md](CODEX_HISTORY_SERVICE.md). It does not enumerate an account’s native threads.

## Host wiring

```typescript
import { CodexHistoryPanel } from './codex-history.js';

const historyPanel = new CodexHistoryPanel(document, {
  getToken: () => token,
  getProjectPath: () => workbench.historyProjectPath(),
});
historyPanel.start();
```

`getToken` returns the existing human control bearer. `getProjectPath` returns the current canonical daemon `ProductState.projectPath`, using the host’s `canonicalProjectPath`/`historyProjectPath()` accessor. The controller compares exact strings and never infers a project from thread IDs, DOM text, browser paths or native account metadata. An empty path before host state arrives refuses requests with a visible notice. Changing the path or bearer invalidates pending results and cached selection. The callbacks are not invoked at import, construction, start or resume.

`root` can be a `Document` or a containing `HTMLElement`. An element root resolves all controls within that element. `options.ids` can override any of the eight ID mappings. The default export contract is the named class `CodexHistoryPanel`; `CODEX_HISTORY_IDS` contains its default mapping. There is no runtime import from the daemon, native client, filesystem or live chat controller.

Mount only after all controls exist. Resolve all eight controls before binding listeners. The controller sets both buttons to `type="button"`, sets an accessible name on the select, and assigns live status roles. Place it in a separate history panel beside the existing live transcript. The live chat’s messages and streaming events never enter this controller.

| Default DOM ID | Required element | Purpose |
| --- | --- | --- |
| `codex-history-refresh` | `button` | Explicitly read the locally recorded project binding |
| `codex-history-thread` | `select` | Explicitly select the exact recorded native thread |
| `codex-history-load` | `button` | Explicitly read native public history through the existing connection |
| `codex-history-status` | container | Recording timestamp, source, public entry count and completeness |
| `codex-history-notice` | container | Authentication, stale binding, connection or acknowledgement notices |
| `codex-history-scope` | container | Canonical project, native thread ID and recorded session ID |
| `codex-history-entries` | container | Separate public history entries |
| `codex-history-gaps` | container | Incomplete marker and bounded omission evidence |

The scope text contains newlines; the host can use `white-space: pre-wrap` on its scope container. Generated styling hooks are `codex-history-entry`, `codex-history-sender`, `codex-history-meta`, `codex-history-text`, `codex-history-incomplete` and `codex-history-gap`. Each entry uses `article`, `strong`, `p`, and `pre`. Style the text block with `white-space: pre-wrap`, `overflow-wrap: anywhere`, and `font: inherit` for the requested clean red/charcoal reference. The controller adds no CSS or inline visual tokens. All data reaches the DOM through `textContent`; native content is not interpreted as HTML, Markdown or instructions.

## Lifecycle and explicit human actions

- `start()` binds once, clears history controls and shows the unread state. It performs no request and does not read the token/project callbacks.
- `stop()` aborts the controller’s pending HTTP operation, fences late responses, clears selection/history and disables controls. The controller also calls it on `pagehide`. If a native read was sent, it reports the missing acknowledgement without retrying.
- `resume()` re-enables the unread panel. It never restores a native connection, resumes a thread, fetches a recording, or replays an action. Calling it while already running is inert.
- `dispose()` stops, removes all listeners and prevents later restarts. The host’s pagehide handler may call `stop()` as well; duplicate calls are safe.

Refresh/load require `event.isTrusted`; synthetic click/change events cannot initiate history requests or select a binding. Keyboard activation of native browser buttons remains supported. There is no public network action method. A busy operation disables every control and repeated clicks remain single-flight.

1. **Read recorded thread** sends only `GET /v1/codex/history` and validates `{nativeHistory}` against the host project. It displays zero or one selectable binding and deliberately leaves the selection empty. Reading this cache is allowed offline after daemon restart.
2. **Select the recorded thread** displays its cached sanitized recording, including exact sender/thread/session/turn/item IDs, without a request. If `recorded` is null, the UI says that no public history has been recorded. It does not fabricate messages or claim the thread has no native history.
3. **Load native history** sends `GET /v1/codex/state` to check the latest exact binding and existing ready connection. Disconnected/busy/foreign bindings refuse the native POST. A fresh ready connection with `snapshot.thread === null` is accepted: history reading does not require model selection or thread resume.
4. An eligible explicit load sends only the singular `POST /v1/codex/action` with a fresh UUID and the existing connection:

```json
{
  "requestId": "<fresh UUID>",
  "connectionId": "<existing ready native connection UUID>",
  "action": "history-load",
  "threadId": "<exact selected nativeHistory.threadId>"
}
```

No project/session/parser options, host executable, token or initiation flag appear in the body. The browser supplies its real same-origin POST Origin; the controller never fabricates an Origin header. Every request uses a relative endpoint, human bearer, `mode: 'same-origin'`, `credentials: 'omit'`, `referrerPolicy: 'no-referrer'`, `redirect: 'error'`, and `cache: 'no-store'`. The daemon remains authoritative for exact Host/Origin and human-versus-agent bearer checks.

The acknowledged receipt must match action/request/connection/thread. Its recording must match project/thread/session, request/connection and source provenance. Failed or unverified POSTs preserve the previously verified cached display, show the request ID, disable another native load until an explicit cache refresh, and never replay. A timeout, host context change, stop or disposal fences late responses. Browser cancellation does not claim to undo a native read that may already have completed.

The live chat’s existing action receipt parser must accept `history-load` when refreshing its action list. Main owns this integration, markup, static module routing, doctor mappings, CSS and the final product build/browser checks. Serving this module under the same path pattern as `learning-panel.js` is sufficient; the history module has no runtime dependencies.

## Display and limits

Only the service’s recognized `user`, `assistant` and `tool` public text projection is accepted, labelled User, Codex and Tool. Raw envelopes, private reasoning/analysis/plan roles, deltas, extra projection fields, accessor-based payloads, mixed bindings and rejected parser results fail closed. State events, approvals, last snapshots and streamed deltas are never rendered or appended. Each recording replaces the history container; identical scoped native IDs deduplicate, conflicting IDs reject the projection, and equal text with different IDs remains separate. The controller also removes the current human bearer from displayed strings; service-side credential redaction remains authoritative.

Bounds match the backend: 2 MiB UTF-8/JSON-escaped projected history, 256 entries, 64 distinct entry turn IDs and 328 gap diagnostics. HTTP bodies are streamed with a 4 MiB wire-response cap matching the route bound, Content-Length/MIME checks and fatal UTF-8 decoding. Entry text and cumulative projected JSON have separate checks. IDs are bounded to 256 bytes; paths to 4096 bytes. Sparse/accessor arrays and unrecognized gap reasons fail closed. A request deadline defaults to 45 seconds; optional `deadlineMs` may be reduced or set up to 60 seconds. It settles even if a test transport ignores abort.

Gaps, truncation, dropped gap diagnostics or an incomplete status always produce the exact marker:

```text
[History incomplete: some content was omitted or truncated.]
```

Gap reason and turn/item evidence remain visible, along with the count of omitted diagnostic details. Excluded private items are counted separately; their omission does not falsely declare missing public text. Complete empty public history and incomplete empty history have distinct messages. Recording timestamps/source labels describe the received recording and do not assert current native contents or installed-CLI runtime proof. No execution permission is granted by displaying history.

## Focused proof

Strict TypeScript compilation passed for only `apps/desktop/src/codex-history.ts` and `tests/unit/codex-history-ui.test.ts`, inheriting the repository’s compiler options with explicit workspace Node type roots. The 23 focused UI tests passed with zero failures or skips. Compilation output and its configuration were isolated under:

```text
C:/Users/alexk/AppData/Local/Temp/arcane-history-ui-check-5330cae4-e2e1-4e95-8753-989ea242d49d
```

Tests cover both root modes, lifecycle inactivity, trusted versus synthetic events, exact singular route/body and privacy options, separate cached/live displays, restart/offline access, no-resume native reads, sender/native IDs, textContent safety/token removal, empty/incomplete states, byte/turn/item/gap bounds, getters/private shapes, deduplication, invalid tokens, stale project/control changes, receipt/provenance mismatches, MIME/UTF-8/redirect rejection, cancellation/deadlines and ignored abort/late responses. A source audit ran with `ARCANE_HISTORY_UI_SOURCE_ROOT` set to this checkout and checked absence of runtime imports, account enumeration, lifecycle/model actions, transcript paths, HTML sinks and live-chat input IDs.

These are deterministic browser-controller fixtures, not a rendered browser or real native CLI execution. Main performs the final browser/snapshot/build verification. No shared/root build, full suite, native authentication, transcript-file reads, Studio/model calls or commits ran in this UI task.

Changed files are limited to the assigned new controller, focused test file and this integration note.
