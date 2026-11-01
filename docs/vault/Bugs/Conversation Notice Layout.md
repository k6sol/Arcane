---
type: bug
project: Arcane
tags: [arcane, chat, errors, layout]
---
# Conversation notice layout

Ordinary conversation notices previously re-entered document flow when shown, shifting the transcript and composer. They now occupy a bounded panel below the conversation header. Expanded details scroll inside it; narrow layouts use a compact inset. Existing live-region announcements, Review/Details controls and rest behavior remain. This complements the earlier sign-in recovery overlay rather than changing request, acknowledgement or retry semantics.

Strict compilation covers 660 sources. A frozen 52-case compiled/browser selection passes with zero skips/cancellations. Actual Edge checks at 1440, 980, 540 and 375px compare transcript/composer/Send geometry before and after notices, expanded details and detail scrolling; they preserve draft text and input focus. Nearby actual mouse drag/sidebar and Studio UI fixtures also pass; all 37 fixture native connections close, with no live Studio calls. This is controlled browser evidence. The loaded e813 app remains unchanged, and [[Shared Draft Readiness]] remains open.
