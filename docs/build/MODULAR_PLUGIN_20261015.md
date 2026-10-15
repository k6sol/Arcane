# Modular plugin delivery — 15 October 2026

The preferred artifact is `ArcaneLocalBridge.rbxmx`: one enabled Script with thirteen child ModuleScripts. Each source remains limited to 199,999 bytes while the combined hierarchy can grow beyond that bound. The XML `.rbxm` compatibility alias remains available. The builder's in-memory factory representation exists only for offline VM fixtures; no single-script `.lua` plugin is emitted or packaged.

The builder, installer, daemon import-preparation hash, product doctor and local/Windows release requirements now agree on the preferred modular artifact. Deterministic build verification still covers all normalized sources and both XML artifacts. Windows checkout rules preserve XML bytes. Check mode rejects a leftover `.lua`; rebuilding removes only a recognized generated legacy bundle, and release creation refuses a mixed delivery.

The installer verifies the complete build before changing a selected folder, preflights all known filenames, preserves unrelated files, keeps backups outside the active plugin directory, and migrates recognized legacy aliases. Repeating an identical installation reports unchanged. Installer acceptance uses disposable folders only.

Validation includes type checking, independent XML reconstruction and hierarchy checks, aggregate source above the single-script bound, legacy cleanup, installer migration and refusal paths, import hash checks and release fixtures. Exact final suite results are recorded in the implementation handoff after execution.

Actual native Studio loading, the connected mesh-upload path, packaged customer acceptance, application signing and the overall product goal remain open. No Studio operation or real plugin installation is part of this change. SSH commit signatures are separate from Windows application signing.
