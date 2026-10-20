# Portable VFX authoring

Arcane includes an original VFX skill and a self-contained toolkit under `skills/arcane/arcane-vfx/toolkit`. Its separate `vfx-skill` branch contains only the portable repository and can be cloned independently. The app skill keeps its native effects recipes and adds deferred format, preview and runtime references.

The Python helper validates finite particle timelines, writes seeded transparent 4x4 atlases, exports client runtime data and produces a local orbit/scrub preview with a timestamped contact sheet. Three editable examples cover ember/icy impacts and a portal pulse. The runtime bounds concurrent effects and particle reservations and owns cancellation and lifetime cleanup.

Offline authoring, preview-math and fake-engine runtime checks cover their own contracts. Browser verification and engine acceptance are separate. The browser preview approximates native randomness, lighting and blending. Texture publication, native rendering, device performance and the complete Studio journey remain unverified. No new MCP asset-upload or generation tool is introduced by this guidance update.
