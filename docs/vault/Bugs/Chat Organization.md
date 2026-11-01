---
type: bug
project: Arcane
tags: [arcane, chat, folders]
---
# Chat organization

The sidebar previously had no drag handlers and displayed persisted empty draft links as chats. Saved drafts now remain in their existing storage and draft tabs, while the sidebar includes a conversation only after a recorded user message. Preparing a Send, a provider binding alone or an error without a submitted user message does not qualify. Existing shared draft identities and persistence gates remain unchanged.

Saved chat rows support native browser dragging into folders and back to the Chats section. A successful drop expands the destination folder and uses the existing library move/save path. The gesture carries a private random token bound to the controller's current project and source chat; external payloads cannot move a chat. Dragging does not open a native conversation or submit a prompt. Existing folder menu movement remains available without dragging.

Strict compilation covers 660 sources. A frozen 41-case selection passes with zero skips/cancellations, including actual headless Edge mouse drags both ways, encrypted-host bridge save projections, external-drop refusal, preserved hidden drafts and first submitted-message visibility. Source and compiled inputs remain unchanged during verification. This is controlled browser evidence, not installed customer acceptance. The loaded desktop remains e813 pending exact-source hosted/package checks and delivery. [[Shared Draft Readiness]] remains a separate open Send blocker.
