# Unified conversation workspace

Scope: `studio.html`, `studio.css`, `workspace-shell.ts`, `workspace-unified.test.ts` and this note. The native controller, daemon, native launch and server routes are owned by the main agent.

## Implemented behavior

- One existing `codex-panel`, transcript and `codex-compose` textarea stay mounted. Blender and Roblox Studio navigation selects presentation context; it never creates, resumes, resets or submits a native thread.
- Blender includes model, material, texture and animation context. Roblox Studio includes scenes, scripts and game systems. Selecting a tool does not modify the draft.
- `new-chat` retains its control ID for compatibility and now focuses the current conversation. Its visible label is Conversation. Ctrl/Cmd+N also focuses that same draft.
- Add tool context appends a plain text description and explicitly states that it does not grant permission. Existing text remains byte-for-byte intact. A bubbling input event follows successful additions; UTF-8 and textarea limits reject additions atomically.
- The sidebar, topbar and search select the same tool state. A capture listener on tool navigation prevents the legacy go-assets workshop scroll, including after pageshow. It still calls the existing secret-dismissal callback.
- Settings navigation opens only the ancestor details needed for its literal target. Connections, model selection, thread controls, asset templates, Studio keys, commands, diagnostics and recorded work retain their original IDs and handlers behind initially closed settings.
- Unknown acknowledgement and native approval controls stay in the conversation. They remain bounded scrolling regions; they are not moved into settings. No native authorization or confirmation implementation was changed.
- The right preview starts with an empty asset-previews container. Existing verified-manifest canvas rendering, selection, downloads and fullscreen remain the source of real output.
- Decorative eyebrow headings and status pill styling were removed. Live state, scope, denial, unknown acknowledgements and approval warnings remain plain readable text.
- Layout reserves the composer beneath independently scrolling conversation content. Standard UI text has a 12px floor, visible focus, forced-colors selection and reduced-motion support.

## Integration contract

`startWorkspaceShell(document, dismissConnectionSecrets)` retains its existing signature and cleanup contract. `WorkspaceShell.activeTool` returns `all | blender | roblox`.

A human change of tool dispatches `workspace:toolchange` on the document, with `CustomEvent<WorkspaceToolChange>.detail = { tool }`. This is a presentation signal with no thread identity, permission or execution semantics. Initialization and pageshow restoration do not dispatch it.

If the main controller consumes that signal, it must read the currently acknowledged native thread ID from its own snapshot. Tool executions must remain in that exact thread and use existing native scope, authorization, confirmations and uncertainty handling. Switching tools is never evidence of authorization.

This change does not implement a server association between standalone asset jobs and native threads. The asset service retains its existing explicit job flow; backend conversation association and in-chat job receipts remain future integration work. Selecting presentation context alone is not sent to the native model. The explicit Add tool context button includes context in the current unsent message.

The current user browser and daemon were not reloaded, restarted, connected or used for inference. Main owns actual browser rendering and server integration verification.

## Focused validation

`workspace-unified.test.ts` checks thread/transcript/draft preservation, capture ownership against legacy scrolling, permission-neutral context append, character and UTF-8 limits, explicit detail reveal, search, cleanup/pageshow and inert markup. Run with a narrow TypeScript compilation to a temporary directory followed by Node's test runner. No full build, full suite, native CLI, inference, Studio or Git action is required.

## Verified result

Strict isolated TypeScript compilation passed and all 7 focused unit tests passed. A separate network-blocked headless Edge fixture confirmed the composer remains in view at 945×618, 1440×900 and 390×844, with no horizontal overflow and a 12px minimum visible control font. The 945×618 fixture also kept the composer visible with unknown acknowledgement and approval regions both populated. All 280 pre-existing control IDs remain present exactly once. These checks are isolated fixtures; main still owns verification against the running native controller and browser.

Core UI source is stable and test-ready. No full build, full suite, Git, native CLI, inference, Studio launch, current browser reload or daemon restart was performed.
