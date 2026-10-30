---
type: bug
project: Arcane
tags: [arcane, chat, updates]
---
# Restart and empty chats

The older running desktop refused Restart to update after a completed, unknown connection attempt with `FRAME_LIMIT`. Its durable action journal records a finished connect without a connection, thread or turn, and no pending actions. Empty sidebar conversations also had no close control. These are separate from an active model turn or an unsaved draft.

The restart correction re-reads the original service state before and after persistence. Only matching finished, unbound unknown connect receipts can pass this exception. Active or retained tasks, current sessions, pending actions, incomplete receipts, failed reads and workspace changes still block it. Draft and queued-message acknowledgements remain required. The original unknown receipt stays recorded and visible after reopening; neither checkpointing nor saved-login startup retries it. Native daemon shutdown must still complete before relaunch.

Empty sidebar records receive a keyboard-accessible Close empty chat button. The exact record must still have no provider binding or messages when clicked. Closing the active empty row clears its library selection without opening another conversation, sending anything or deleting a provider draft. Existing save failures remain visible and block restart until saved. Bound conversations and saved history are preserved.

The separate bounded native inventory pagination correction already exists in the selected newer installation. The user has closed the older window and authorized opening the verified update when ready. No uncertainty was acknowledged and no prompt was replayed by the agent. Updated customer acceptance remains open.

## Acceptance

- [x] Reproduce the old-window failure and inspect the original journal without replay.
- [x] Implement focused restart and empty-row controls.
- [x] Execute focused persistence, lifecycle and sidebar regression cases.
- [x] Pass exact-source hosted checks and install the attributable update.
- [ ] Verify the user's updated restart and chat journey.

Related: [[Delivery/G02 Reliable Chat]], [[Bugs/Native Connection Inventory]], [[Operations/Current State]].

Local evidence:645-source compilation and194 final focused chat/sidebar cases pass with no skips, including a new refusal when uncertainty arrives during a held draft save. All eight separately enabled real Edge chat journeys pass across the recorded scoped runs: seven passed in the broader run, and the corrected delayed-response/storage case passed independently. The fixture now serves the daemon's exact nested package routes and waits for actual boot; its older expectation that accepted user text disappears after disconnect was independently reproduced against the authenticated installed baseline. The replacement requires the accepted prompt exactly once and rejects a unique, schema-validated late assistant delta without reconnection or another turn. The exact sign-in presentation record remains checked for its public schema, with existing secret checks intact.

All44 update-host cases,49 desktop-host cases and the enabled real-browser update case pass. An isolated real Edge sidebar verifies Enter/Space dismissal of exact inactive/active records, preserved history/unsent provider text, zero provider opens/sends and no page errors. These are controlled tests, not an authenticated customer journey.

## Hosted diagnostics follow-up

Original run[41113346266](https://github.com/k6sol/Arcane/actions/runs/41113346266) on signed `2b92516` completed five lanes successfully. Windows unit2 timed out in the unchanged diagnostics case that checks one durable rejection, exact replay and read-only HTTP routes. Its five-second watchdog reported10.45seconds; the old log has no internal phase witness, so the cause remains unproved. Packaging was skipped; this candidate was neither promoted nor installed.

An unchanged local run passes all14 diagnostics cases, with the affected case completing in97ms. The follow-up fixture uses owned core HTTP requests, complete bounded JSON responses, the same authenticated routes and original one-second request/five-second case limits. It retains every report, durability, replay and privacy assertion, registers server cleanup before listening, and records fixed phase durations only on failure. Global-fetch initialization is removed from this transport-independent reporting check; that is not a retrospective attribution of the hosted timeout. Actual fetch/browser coverage remains separate. Production code is unchanged by this follow-up. All645 sources compile and39 focused diagnostics/reporter/privacy cases pass locally with no skips. Fresh hosted verification remains required.

## Installed verification

Signed `fa7d730` passes all seven jobs in [41118208318](https://github.com/k6sol/Arcane/actions/runs/41118208318); unchanged native workflow inputs retain the two passing669 jobs. Its authenticated closed payload was installed with observed original exit zero, both pipe EOFs, no issues and the exact selected manifest. The existing launcher/profile and prior releases were retained; the actual updated window was opened under explicit user authorization.

After inspecting the exact finished connect record and refreshing its status, the agent locally marked that notice reviewed. The original unknown journal record remains unchanged, with no old prompt replay. Saved login then recovered automatically. New chat retained gpt-6.1-sol/low; one fresh native prompt was acknowledged once and produced the expected reply. The message remained visible and no tool activity occurred. This is actual installed native chat evidence, not a Studio build or full-product acceptance. Banner-driven restart in a future genuine update remains open.

The live check also exposed an extra empty sidebar record after first Send: three empty records became one bound record plus three empty records. Source audit confirms that the explicit draft row lacks correlation with the stable provider draft ID. Follow-up must bind the exact successful original draft to its exact library row, preserving stale/provider/project/reload fences and historical records. Existing empty rows remain individually dismissible.


## Exact first-Send correlation

The next candidate keeps the successful original provider-local draft linked to its exact library row, persisted through the actual strict preload and encrypted host schema. A refused or tab-limited New chat creates no sidebar row. Existing native ownership wins; unrelated or legacy empty rows are never guessed. Empty-row dismissal prunes only its presentation links. Local draft reopening and unsent provider round trips reuse the original draft. Fresh Claude draft keys use unique incarnations instead of restarting a numeric sequence.

Before releasing Send, the exact library checkpoint is acknowledged without the debounce delay; source, provider, project, navigation, selected row and native identity are rechecked across each await. Save failure retains the typed draft and prevents later native effects. Existing provider-tab preferences and library links remain separate records: this does not prove atomic crash recovery across both stores. No uncertain native request is replayed.

Validation: all645 sources compile,201 focused Node cases and56 actual preload/encrypted-host cases pass. All eleven existing focused Edge journeys pass at their recorded scopes. A separate actual Edge fixture keeps three rows at three after first Send and reload, retains the exact original row and one user message, and records no page errors or native calls. The actual CodexChat/ChatTabs/service/SQLite integration separately proves one acknowledged third-row binding with a controlled host and a headless library document; it is not real-provider or DOM acceptance. An existing drawer expectation reproduced against the pre-change UI and was corrected to verify Blender's actual Tools modal/focus behavior; its original failure is retained. Hosted and installed customer acceptance of this candidate remain pending.
