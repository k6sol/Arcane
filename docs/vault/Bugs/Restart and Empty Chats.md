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
- [ ] Pass exact-source hosted checks and install the attributable update.
- [ ] Verify the user's updated restart and chat journey.

Related: [[Delivery/G02 Reliable Chat]], [[Bugs/Native Connection Inventory]], [[Operations/Current State]].

Local evidence:645-source compilation and194 final focused chat/sidebar cases pass with no skips, including a new refusal when uncertainty arrives during a held draft save. All eight separately enabled real Edge chat journeys pass across the recorded scoped runs: seven passed in the broader run, and the corrected delayed-response/storage case passed independently. The fixture now serves the daemon's exact nested package routes and waits for actual boot; its older expectation that accepted user text disappears after disconnect was independently reproduced against the authenticated installed baseline. The replacement requires the accepted prompt exactly once and rejects a unique, schema-validated late assistant delta without reconnection or another turn. The exact sign-in presentation record remains checked for its public schema, with existing secret checks intact.

All44 update-host cases,49 desktop-host cases and the enabled real-browser update case pass. An isolated real Edge sidebar verifies Enter/Space dismissal of exact inactive/active records, preserved history/unsent provider text, zero provider opens/sends and no page errors. These are controlled tests, not an authenticated customer journey.
