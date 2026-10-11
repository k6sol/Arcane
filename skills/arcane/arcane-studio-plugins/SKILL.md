---
name: arcane-studio-plugins
description: "Build Roblox Studio tools with dock widgets, editor-aware operations, scoped connections and safe unload/update behavior."
license: MIT
---

# Roblox Studio plugin authoring

## Separate editor tooling from game runtime
Define the plugin's permitted operations, installation route, UI and data scope. Use supported toolbar/widgets and current Studio privilege APIs. Do not write arbitrary evaluation into game scripts to work around missing plugin capabilities.

For external bridges, use authenticated loopback transport, explicit sessions, bounded messages and capability negotiation. Pairing tokens and task grants are not provider credentials. Keep status, target and disconnect visible.

Source edits honor open buffers and concurrent work. Group changes through supported history recording while recording actual partial outcomes. Own toolbar handlers, polling and widgets and clean them on unload. Persistent settings should not leak long-lived cloud/provider secrets.

## Verification
Build/install in a disposable Studio environment; test narrow panel, theme, reload, reconnect, denied HTTP permission and stale target. A generated plugin source file is not proof of a working installed plugin. Do not silently overwrite other plugins or user configuration.
