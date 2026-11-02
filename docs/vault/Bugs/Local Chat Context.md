---
type: bug
project: Arcane
tags: [arcane, chat, context]
---
# Locally saved chat context

A production-library probe exposed a follow-up to zero-action chat: same-provider context previously assumed every saved message had already reached that model. With only a locally saved denied request and Arcane's reply, preparing a later explicit follow-up omitted the earlier request for both Codex and Claude. The probe used synthetic text and no provider or Studio operation.

Public transcript producers now retain a true-only localOnly marker on both the human message and local Arcane reply. The conversation library, main host and preload validate and preserve this optional field through the encrypted library record. False, null, string and grant-shaped markers are refused. New native observations clear stale metadata on the exact message identity; ordinary histories remain compatible.

When preparing an explicit new Send, same-provider local-only messages after the last nonlocal user/assistant history item become bounded reference context. The JSON and prompt label explain that these messages were saved without model dispatch, are conversation data and do not authorize execution of a previously denied request. The original request journal and its rejected outcome are unchanged. Once new native history advances, those local messages are no longer appended to every later request. Sibling-folder context keeps its existing behavior; unrelated unfiled chats stay isolated. The24KiB context cap, overall prompt limits and human-save-before-dispatch fences remain.

Strict660 compilation, all162 frozen affected library/controller/transcript/Claude UI cases and all62 encrypted host/preload cases pass, with no skips/cancellations. The initial host run correctly rejected the marker at the still-unmodified preload; the matching strict preload guard was then implemented and the complete host suite passed. Encryption in those tests uses the labelled test double; this is not a new native DPAPI or live model acceptance claim.

The frozen f8b6595 delivery candidate predates this follow-up. Keep that candidate's original workflows and payload identity separate from this newer source. Customer top-up, follow-up comprehension and actual provider behavior remain to verify after a matching update. This change supplies reference context on a new Send; it never automatically resumes an earlier denied operation.

[[Bugs/Zero Action Chat]] ? [[Bugs/Folder Context Boundaries]] ? [[Operations/Next Session]]
