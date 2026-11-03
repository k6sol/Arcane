---
type: bug
project: Arcane
tags: [arcane, chat, deletion]
---
# Shared chat deletion

Status: **In progress**. The customer reports that saved chats cannot be deleted and no confirmation appears. Source confirms the shared sidebar returns only an open button for rows with saved bindings/messages; its close action is limited to empty rows. Claude's older native-history menu has a separate two-click control, and the Codex integration has no thread/archive path. A closed tab or hidden row must not be presented as a completed deletion.

## Verified storage foundation

ConversationLibrary now supports deletion of Arcane's project-local chat record: messages, folder context and draft links are removed, unrelated conversations/folders remain, and the selected ID clears only if it belonged to that chat. Minimal provider/native-ID markers prevent late provider updates from recreating deleted text, including after reload. This operation does not erase the provider's original history, assets, Studio changes or external accounts; the eventual confirmation must state that scope explicitly.

Renderer, preload and encrypted main-process validators recognize the same bounded optional marker shape. Empty, duplicate, unknown-provider and live-overlap markers refuse. Existing records without markers remain valid. A stale save cannot remove already persisted markers, preventing older windows from restoring deleted history. Aggregate storage/context caps remain unchanged; marker capacity refuses atomically rather than forgetting earlier deletions.

Strict compilation verifies660 sources. All28 frozen shared-history domain cases and64 isolated preload/encrypted-host cases pass without skips. These cover folder-memory removal, associated draft links, native/provider identity separation, reload/late events, capacity refusal, encrypted roundtrip and stale-write refusal. The initial host run passed63 and failed1 because preload did not yet recognize the new field; that original failure is retained. No customer conversation or native provider data was deleted.

## Remaining UI and acceptance

Implement the actual saved-chat action and accessible explicit confirmation, default Cancel/focus restoration, clear in-progress/failure outcome and durable save acknowledgement. Respect active-work and unsent-draft ownership, the exact current project/provider binding, provider switches and repeated clicks. A failed save must retain the visible chat/confirmation state rather than claim success. Verify late events/reload/folder context, all providers and narrow layouts in real browser fixtures. Use synthetic test chats; preserve the customer's conversations. The current installed69d8a87 does not expose this new UI yet.

[[Operations/Requirements Ledger]] - [[Delivery/G02 Reliable Chat]] - [[Operations/Next Session]]
