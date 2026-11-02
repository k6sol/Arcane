---
type: bug
project: Arcane
tags: [arcane, chat, diagnostics]
---
# Saved chat failure explanations

The shared conversation controller replaced a provider's failed-open explanation with a generic saved-conversation notice. That hid useful details such as pending work, missing model selection or retained session custody, even when the provider had already reported the actual blocker. This code path explains lost detail; it does not establish which blocker caused the customer's native resume failure.

Saved native opens now clear the prior provider notice before the attempt and retain the new renderer-safe explanation on refusal. If that attempt supplies no explanation, the original generic notice remains the fallback. Stale errors cannot be attributed to the new attempt. Failed navigation still restores the prior library selection and retains the current provider chat and draft. Draft-link refusal keeps its existing notice behavior. No request is retried, and native recovery or ownership gates are unchanged.

Strict compilation covers660 sources. All54 frozen shared-conversation and Codex UI cases pass in actual Edge, without skips/cancellations or source/compiled mutations. The new regression proves specific refusal retention, stale-error clearing, generic fallback and preserved prior chat/draft selection. Broader UI fixtures use explicitly synthetic native clients; no provider inference or Studio calls occurred. An initial misspelled test path was refused before tests started. Customer/native saved-thread opening and the full Figma connection/review/import workflow remain unverified.

[[Bugs/Chat Organization]] · [[Operations/Current State]] · [[Operations/Next Session]]
