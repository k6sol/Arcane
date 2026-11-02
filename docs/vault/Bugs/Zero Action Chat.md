---
type: bug
project: Arcane
tags: [arcane, chat, actions]
---
# Zero-action chat

The customer requires Send to remain usable when Arcane actions are exhausted. The human message is saved and Arcane replies locally with the actual monthly reset date and Plans/API-credit options. This must not dispatch a provider turn, charge credits, grant work, automatically retry the saved request, or end an already running reply.

Codex keeps its durable per-request submitted message and attaches an Arcane-owned local reply only after the actual subscription admission refuses. Native acknowledgement remains rejected; local display says the message was saved with no model request. The original journal request cannot be replayed into a later provider dispatch. Actual transmitted bytes are zero. The local reply and human message merge once, survive storage reads and use the original thread/session scope. The composer is not repopulated with an already saved prompt. Queued local outcomes are retired rather than retained for an automatic provider resend.

Claude saves the user message and local assistant reply through the existing conversation store, then returns its normal message acknowledgement without allocating a provider process, credential or asset preparation. A local-only delivery marker makes details say Arcane and no model request. During an existing response, a refused steering request produces local messages without writing stdin or finishing that original response; local display does not replace the running stream. Local completion does not clear native provider usage-limit evidence or invoke automatic reply-finished/model work hooks.

The production reset reply uses the actual local ledger UTC month boundary. API-credit models remain a separate billing path; Plans links/options do not imply the currently unconfigured hosted credit service can already take payment. These are workspace-local allowance semantics, not hosted paid-plan or account-wide enforcement acceptance. Existing unrelated authentication, unknown-ACK and storage-integrity fences remain.

## Verification

Strict660 compilation passes. The complete initial255-case backend/chat/queue/history run passed253 cases; two history presentation assertions failed and were corrected in the separate history change. The final176-case UI run passes with no skips/cancellations and unchanged source/compiled input hashes. Its real Edge test submits two zero-action messages through production HTTP/service code, retains both messages/local reset replies, keeps the composer usable and records zero synthetic native turn starts. Claude host tests verify no native process/credential/preparation for local completion and no stdin write/kill/done event for the already-running reply. Additional UI schedules preserve that running stream. Storage/merge checks retain the reply once with zero transmitted bytes. Hosted bridge and actual preload action-unit checks both pass. These are controlled native clients/synthetic Studio boundaries, not a live customer model or Studio test.

Customer installation, reopening with retained data, actual taskbar identity and successful native Send remain to verify on the final package. Saved locally does not authorize later automatic execution of the denied prompt; context/reference behavior after a top-up should be included in customer chat acceptance.

[[Bugs/Action Code Redemption]] ? [[Bugs/Subscription Action Admission]] ? [[Operations/Next Session]]
