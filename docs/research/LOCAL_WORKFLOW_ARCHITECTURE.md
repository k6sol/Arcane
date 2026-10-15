# Local development workflow architecture

15 October 2026

Arcane's ordinary development workflow should run through its local daemon, Studio plugin, local asset workers and the user's supported AI connection. The desktop presents conversations, plans, changes, previews and measured results. Provider usage limits and optional publishing services remain explicit; local tool execution does not require a separate action-credit system.

The daemon owns exact project/conversation identity, provider session continuity, job lifecycle, tool admission and retained evidence. MCP exposes the supported operations to native coding clients. Tool discovery, execution acknowledgement, measured verification and final presentation are distinct states. Reconnecting a transport does not establish that an earlier change succeeded or authorize replay.

## Implementation priorities

1. **Source discovery:** [bounded script-content search](../script-content-search.md) now provides real refs, line/byte-column evidence, excerpts, scan counts and explicit truncation within a granted root or observed subtree. Read the current editor source again before an update; a match is not an edit baseline. Native acceptance remains required.
2. **Continuous execution:** connect accepted chat tasks to an owned dispatcher and carry exact project, conversation, account and model identity through workers. Return plan/build/verify/repair evidence to the originating chat. Preserve stop acknowledgement and uncertain-effect recovery.
3. **Local asset delivery:** finish reconstruction-to-import, update/reimport mapping and visible engine acceptance. Keep source artifacts, approved rights, local geometry transfer and published assets separate. A GLB or successful local preview alone does not establish Studio delivery.
4. **Visual iteration:** retain source-bound multi-view renders, timestamped capture moments and review sheets. Revisions must target the same asset or effect. Extend to rigs, animation and VFX with measured scale, timing, cleanup and final engine appearance.
5. **Customer acceptance:** verify packaged desktop startup, supported AI connection, paired plugin, real change/asset work, testing and selective restoration as one repeatable journey when native Studio work is authorized.

## Verification boundaries

The existing implementation includes native Codex conversations, bounded scene/script tools, local Blender recipes, asset previews, finite playtest scenarios and one-repair task handling. In-app Claude parity, an actual cooperative dispatcher, complete engine asset delivery, advanced assets and native customer acceptance remain required.

Standalone Luau fixtures exercise plugin source without opening Studio. SDK/HTTP/SQLite tests exercise local integration. Browser and executable checks exercise their own presentation/startup paths. None substitutes for native Studio or a complete customer journey. The full product brief and all eleven work areas remain authoritative.
