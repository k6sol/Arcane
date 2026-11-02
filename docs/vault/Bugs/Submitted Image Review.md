---
type: feature
project: Arcane
tags: [arcane, gui, review, evidence]
---
# Submitted image review

The existing work inspector displayed submitted evidence metadata and a copy-path button, but could not show a GUI preview inside Arcane. It now offers Preview image for submitted PNGs. A modal keeps the page layout stable, shows the image and offers Fit, Actual size and Close. It uses the current theme and fits a phone viewport. Existing human Approve/Request changes controls remain separate; merely viewing an image never approves work.

The human-only read route identifies the task, artifact index and exact submitted SHA-256. It reads only an existing submitted in-project single-link file, rejects changed identity/content/size, limits previews to4MiB and checks PNG header dimensions at most2048 per side. The browser must decode the image before displaying it. These header checks do not claim a complete server-side PNG audit. Missing bearers and model bearers are refused; the route does not expose an arbitrary path reader or an external image URL.

The modal owns its abort signal and object URL. Closing, replacement and page teardown retire the preview; late results cannot allocate a URL or reopen it. Errors show Error439, the failing read/decode stage and a usable explanation. No raw provider output is forwarded. Central hosted error-service setup remains separate.

Strict compilation covers660 sources. All45 affected storage, error-reference and actual-Edge UI cases passed with frozen inputs;37 synthetic native connections closed. A final screenshot/layout refinement passed the targeted complete HTTP/browser work-review case with frozen inputs, including phone bounds, theme rendering, auth denial, changed-file refusal, exact URL revocation and held late results. Desktop and phone images were visually inspected; the grayscale image is an explicit contract fixture, not a generated GUI design. No provider inference or Studio operation occurred.

This is the submitted-image review component. It does not implement Figma sign-in, design creation, interactive prototypes, revision-bound Figma approval or GUI import. Those remain in [[Architecture/Figma GUI Workflow]]. The verified desktop candidate2d08932 predates this feature; do not claim it is installed with that candidate.

[[Architecture/Figma GUI Workflow]] · [[Operations/Current State]] · [[Operations/Next Session]]
