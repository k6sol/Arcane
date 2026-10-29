---
name: arcane-chat-reliability
description: "Diagnose and improve Arcane chat, provider switching, drafts, history and session continuity. Use for functional conversation bugs rather than visual redesign."
---

# Arcane chat reliability

Trace input through desktop draft storage, original native request, acknowledgement, events, history merge and render. Check new and old chats, model/effort persistence and provider bindings. A local accepted indicator should not await slow inference, but it must reflect durable submission rather than invent a native ACK.

Distinguish rejected, dispatched-unknown and acknowledged operations. Never replay an uncertain request to make the interface look responsive. Preserve the original conversation and each message exactly once. Preview return, cancellation and model changes must not replace usable chat with transient sign-in.

Test the user's exact interaction and nearby switch/reopen/restart cases. Preserve genuine provider failures and cleanup errors separately. Follow the approved design while fixing behavior; use existing supported adapters and do not claim unsupported subscription access.
