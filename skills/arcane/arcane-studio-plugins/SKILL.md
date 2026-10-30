---
name: arcane-studio-plugins
description: "Build Roblox Studio plugins with coherent editor workflows, safe source/history operations, authenticated bridges and complete unload/reconnect ownership."
license: MIT
---

# Build editor tools that respect the open project

## Define the tool's editor contract
Identify users, target operations, permitted hierarchy/source scope, installation/update route and the exact output. Separate plugin code from runtime game code. A dock widget or toolbar button needs loading, ready, working, conflict, denied and disconnected states; do not expose a control that silently does nothing.

Inspect available Studio APIs and privileges before choosing an implementation. Script editing must account for open editor buffers and the supported source-edit path. A plugin cannot safely bypass a refused source update by evaluating arbitrary code or placing an executor into the game. Do not infer permission from a selection/name alone.

## Make edits reviewable and recoverable
Read the real baseline and apply only the intended changes. Group a logical edit through the supported history recording mechanism, with cancel/partial-failure behavior. Keep transaction boundaries truthful: an external HTTP request and several engine writes do not automatically share an atomic undo. Do not overwrite manual work that changed after preview.

For tools that generate game systems/content, validate definitions and dependencies before committing consumers. Preserve model pivots, stable identifiers and source relationships rather than flattening a hierarchy for convenience. Surface unsupported classes/properties before allocation when possible, and clean up partially created owned instances on failure.

## Own the plugin lifetime
Assign toolbar handlers, widgets, selection listeners, scheduled work and temporary instances to the plugin instance. Unload/update must disconnect and settle or cancel owned operations without continuing into a new plugin lifetime. Persist only appropriate settings; do not store cloud/provider secrets in ordinary plugin settings or replicated game objects.

An external bridge needs authenticated transport, explicit session/target identity, bounded parsing, capability negotiation and correlation for commands/results. Reconnect must create fresh context; serialized packets or old refs are not replay authority. A lost acknowledgement requires reconciliation, not automatic re-execution. Keep target, connection state and refusal visible without leaking tokens.

## Verify the actual editor workflow
Use a disposable authorized Studio environment for install, first run, narrow dock layout, theme, selection changes, dirty-buffer conflict, Undo, permission denial, reload and reconnect. Exercise unload during a held operation and confirm cleanup/no stale write. Check version compatibility and the actual installed artifact. Generated Luau or a mock UI test proves neither installation nor engine privilege behavior. Leave unrelated plugins and user configuration intact.
