---
type: feature
project: Arcane
tags: [arcane, chat, context]
---
# Folder context boundaries

The folder UI previously described shared memory, but contextFor only forwarded messages between providers in the same chat. Recorded sibling chats were not included. The context builder now includes public user/assistant messages from other chats in the selected folder, including chats using the same provider. Unfiled chats and other folders remain excluded. Moving a chat or removing its folder changes the next submission's scope immediately; the scope survives library reload through existing saved folder membership.

Every context row names its source chat and provider. Errors and unsubmitted drafts are excluded. The active provider's own chat history is not repeated. Recent cross-provider messages in the active chat retain priority over sibling context; older rows are omitted to keep the complete JSON envelope within the existing24KiB budget, with an explicit omission count. The wrapper treats all shared text as conversation data, never tool results, permissions, system instructions or completion proof. If no complete message fits, Send reports the context limit rather than silently discarding all memory.

This is bounded recorded context, not unlimited memory or model training. Sibling context is included on each request while the chat remains in that folder; incremental delivery checkpoints and measured token savings are not implemented. Folder changes affect future requests and cannot erase context already sent to a provider. The exact shared-library checkpoint is still saved before submission releases native work.

Strict660 compilation and all42 frozen conversation-library/shared-controller cases pass with no skips/cancellations or source/compiled mutations. Coverage includes both sibling providers, other-folder/unfiled exclusion, movement, removal, reload, full-envelope size/omission accounting, active handoff priority and the actual before-submit hook. This is controller/data verification, not a native provider conversation. Actual packaged/customer folder conversations remain unverified; do not operate Studio to test this feature under the current restriction.

[[Bugs/Chat Organization]] · [[Operations/Requirements Ledger]] · [[Operations/Next Session]]
