# Chat-first local product acceptance

This extends the existing full local product objective; it does not certify
completion or replace the original requirements catalogue.

## Human-facing flow

1. Launch Arcane and open a project. One short sign-in card if the selected AI
   provider is not genuinely connected. Existing vendor login stays vendor-owned.
2. Choose Codex or Claude Code. Offer supported native sign-in, not pasted
   provider credentials. Missing CLI exposes one install-instructions action.
3. Top tabs are open chats. New chat opens a draft, not an inference turn. Each
   chat owns its draft, native thread binding, model choice and tool presentation.
4. One model picker in the composer. Choices come from the current provider's
   reported catalogue; no made-up models or automatic billing fallback.
5. Roblox, Blender/materials, files and previews are tools/results in that chat.
   Preview stays collapsed until requested or supported observed asset activity.
6. During tasks, show elapsed time and actual reported token usage compactly.
   Unavailable usage is not zero. Estimates are labelled and never presented as
   an actual subscription charge. Do not invent a rate card to fill an empty UI.
7. Save presentation preferences and drafts per canonical project. An EXE
   restart or new random local port must not lose them. Cached metadata never
   establishes authentication, grants or permission to execute a task.

Keep explanations, native IDs and troubleshooting behind Settings. Preserve
keyboard navigation, readable contrast, reduced motion, clear actionable errors,
unsent content, and explicit approval for editing—not decorative status badges.

## Verification matrix

| Gate | Required evidence |
| --- | --- |
| Plugin input | Standard editable TextBox; native user typing confirmation; rejection/replacement and saved-key flows |
| Provider entry | Genuine native login/status outcomes or exact unsupported capability; no renderer credential interception; no inference on sign-in |
| Chat tabs | Independent drafts, exact owned native binding, non-destructive close/reopen, active/pending/unknown switch refusal, no grant carryover |
| Persistence | Real host acknowledged save/recovery across restart and random-port change; project/owner/epoch denial; no plaintext provider credentials |
| Metrics | Supported native usage notification schema, per-turn identity/dedup/stale guards, bounded clock cleanup, honest estimates |
| Frontend | Real rendered production assets, desktop-sized and compact viewports; controls function rather than static demo chrome |
| Preview | Canonical `/studio` frontend; legacy lab only `/diagnostics`. Browser lacks native host APIs and must not fake them. Genuine native preview uses the actual Electron host |
| Delivery | Fresh integrated compile, complete current regression, current package manifest and actual Windows EXE launch evidence |

Passing fixtures for an isolated feature does not satisfy native acceptance or
certify the complete product. The previous Windows bundle predates these
changes and must not be advertised as containing them.

The authorized eight-turn skill evaluation completed, but its disabled
execution-host configuration prevented fixture calls. It supports no skill
benefit or approval claim. That eight-turn permission is consumed and sealed;
further inference requires new human authorization.
