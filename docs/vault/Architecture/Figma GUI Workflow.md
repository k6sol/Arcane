---
type: architecture
project: Arcane
tags: [arcane, gui, figma, approval]
---
# Figma GUI workflow

The requested customer journey is **Connect Figma in Arcane → sign in through Figma → create a task-owned design file → review actual editable screens inside Arcane → revise from user feedback → approve the identified design inside Arcane → import editable Roblox GUI and assets → wire behavior → validate in-game**. Users should not have to create a file first. Previews, screen/state navigation, feedback, revision comparison, Request changes, Approve design, import outcomes and final comparisons belong inside Arcane. External Figma links are optional supporting links; browser authentication remains the account provider's flow. Retain the same task and review history across iterations. Support the requested visual style through a complete design system and required screen/state inventory, with relevant animation/SFX and device/input coverage.

The quality reference is [the Roblox graphics and UI collection](https://builtbybit.com/resources/roblox/graphics-ui/). Use it as a visual/completeness benchmark, not permission to copy marketplace products. The interface skill now declares a Figma review reference covering original art direction, editable designs, revision-specific approval, assets, native GUI translation and actual acceptance. This is shipped guidance, not an implemented OAuth connection or durable import gate.

## Supported integration research

Reviewed official documentation on 2026-11-02: [remote setup](https://developers.figma.com/docs/figma-mcp-server/remote-server-installation/), [tools](https://developers.figma.com/docs/figma-mcp-server/tools-and-prompts/) and [canvas writing](https://developers.figma.com/docs/figma-mcp-server/write-to-canvas/). The remote endpoint is https://mcp.figma.com/mcp; documented tools include create_new_file and use_figma. Remote connections require a listed supported client; a new custom client must request access. Canvas writing also requires an eligible Figma plan and edit access. Do not represent this external capability as unconditionally free or universally available.

No Figma tools are connected in the current agent session, and plugin discovery returned unavailable. Arcane itself has no verified Figma connection. Choose an accepted first-party integration route after confirming support, or obtain client acceptance; do not label a fabricated Connect button as functioning authentication. Do not impersonate a supported client. Keep authentication tokens out of model context, logs and shared notes, using the existing trusted encrypted host boundary when implementation proceeds.

[[Bugs/Submitted Image Review]] now supplies a working in-app component for exact submitted PNG evidence, using existing human review controls and hash revalidation. This is a static image review component; Figma account/file authoring, interactive prototypes and durable approval of a complete Figma revision remain separate requirements.

## Native connection protocol evidence

The installed Codex executable generated its own current JSON schemas successfully in an isolated output directory:320 files,3,676,687 bytes, exit0 and both output pipes closed. This starts no authentication, model inference or Studio work. Its schema includes mcpServer/oauth/login, mcpServer/oauthLogin/completed and mcpServer/tool/call. Login accepts the configured server name and optional threadId; the response returns authorizationUrl and optional loginId. Completion also carries an optional loginId, so an integration must bind the original attempt rather than accept an unrelated late event. Tool calls require a threadId, server and tool: a successful account login alone is insufficient to call design tools.

[Official app-server documentation](https://learn.chatgpt.com/docs/app-server) describes the same login/completion route and requires integrations to identify themselves through clientInfo. This supports further implementation research, not proof that Figma accepts Arcane or that this account can create/write files. Use a separately owned Figma connection and validate the actual remote tool catalogue. Keep the existing arcane-only model connection profile intact. Native OAuth credentials must stay out of renderer/model context and shared records. Browser sign-in, disconnect/expiry, exact revision approval and import remain unimplemented acceptance items below.

## Remaining implementation and proof

The updated pack validates 62 skills and36 declared references. All46 enabled skill checks pass; the unchanged optional Luau compiler check is skipped without its configured executable. The actual loader packs arcane-interface with its figma-review reference within the default budget. The initial inventory check correctly failed until its expected reference count was updated from35 to36. These are guidance/integrity checks, not evidence that Figma sign-in, design generation, in-app review or Roblox import works.

- [ ] Supported authentication route, browser cancellation/retry, encrypted persistence, refresh, disconnect and account identity.
- [ ] File creation with an attributable result and no duplicate file after an uncertain response.
- [ ] Real editable design authoring and preview; revision feedback preserved with the task.
- [ ] Durable user approval bound to the exact design representation; changed designs require renewed review before import.
- [ ] Export manifest, image import results, editable GuiObject translation, font/effect differences and functional controller bindings.
- [ ] Representative style and device acceptance, visual comparison and actual interaction/respawn checks.

Do not operate Studio for this work under the current restriction. Keep the packaged desktop update and original CI work moving in parallel with source-only GUI groundwork.

[[Operations/Requirements Ledger]] · [[Operations/Next Session]] · [[Skills/Development Skills]]
