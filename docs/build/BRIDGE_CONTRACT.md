# Arcane local Studio bridge v1 — implementation contract

This document and `packages/protocol/src/studio.ts` are the shared worker contract. Parent owns protocol, SQLite, HTTP, root dependencies and integration. Workers must not edit these shared files without coordination.

## Transport and permissions

Loopback only. Control bearer is a random launcher token; never a provider credential. POST control routes require exact browser Origin **when an Origin header exists**; native MCP with its own local bearer can omit it. Any nonmatching Origin is rejected. Plugin has a distinct per-session bearer accepted only on plugin routes. One-use pairing code lasts 120 seconds and conveys explicit service-root grants plus read-only/writes flag. Do not put tokens in DataModel or saved plugin settings. Plugin widget enters daemon URL + code; it keeps bearer only in memory. URL must be literal `http://127.0.0.1:PORT`, no redirects/external URLs. Default poll 2 seconds with backoff; single-flight; no busy wait. On daemon restart, old sessions are revoked; dispatched results become needs_reconciliation, never automatically replayed. Raw Luau evaluation, publication, purchases and DataStore operations are not methods.

All payloads JSON. Errors `{error:string,message:string}`. A Studio clientSessionId is generated at plugin load. Place ID alone is never a session identity. Commands target exact paired session, and include clientSessionId, monotonically increasing leaseEpoch, expiry, root grants, write grant. Plugin rechecks all of these and edit-mode status before every operation. It caches completed command IDs/results until receipt acknowledgement and never reruns them. Result maximum 512 KiB, arguments 256 KiB; source text bounded to 100 KiB UTF-8. Refs are session-only opaque IDs registered by plugin, not guessed paths; pathSegments are display-only. Duplicate names must not alias. No automatic fallbacks to another Studio window.

## Control endpoints

- GET `/v1/studio/sessions` → `{sessions:StudioSession[]}`
- POST `/v1/studio/pairing` `{allowedRoots:StudioRoot[],allowWrites:boolean}` → PairingGrant
- POST `/v1/studio/revoke` `{sessionId}` → `{revoked:true}`
- POST `/v1/studio/commands` `{sessionId,requestId,method,args}` → `{command:StudioCommand}`. requestId is caller UUID/idempotency key. Same key and identical payload returns prior record; reuse with different payload fails.
- GET `/v1/studio/commands?sessionId=...` → `{commands:StudioCommand[]}` newest first, bounded 100
- GET `/v1/studio/commands/:id` → `{command:StudioCommand}`
- POST `/v1/studio/restore` `{commandId,requestId}` → `{command:StudioCommand}`. Daemon constructs inverse from immutable succeeded mutation receipt; caller cannot supply inverse. Restoration requires current exact after-state, no clobbering later edits.
- GET `/v1/product/state` → `{projectPath,protocolVersion:1,studioSessions,commandCounts,features,buildTasks}`. Feature status evidence-based; no fake connected indicators.

Provider lab `/v1/state`, `/v1/probe`, `/v1/selection` remain separate and unchanged initially. Product panel uses `/studio`, `/studio.css`, `/studio.js`; no inline script/CSS under CSP. Its launch URL `/studio#CONTROL_TOKEN`. UI removes fragment and sessionStorage holds local token only. Link to provider lab same origin plus token fragment.

## Plugin endpoints

- POST `/v1/plugin/pair` without bearer: PluginPairInput → PairResult. rate-limited code exchanges; bad/used/expired code refused.
- POST `/v1/plugin/poll` plugin bearer `{sessionId}` → `{commands:StudioCommand[]}` (0 or 1 FIFO; single writer; polling records heartbeat). No concurrent mutations; while dispatched unresolved, no later command is delivered. Expired dispatched command becomes needs_reconciliation and next work is blocked pending explicit repair/new pairing.
- POST `/v1/plugin/result` plugin bearer `{sessionId,commandId,state:'succeeded'|'failed',result?:Json,error?:string}` → `{accepted:true}`. Immutable receipt; identical retry accepted, conflicting retry refused. Mutation methods must provide mutation receipt on success. Errors should be bounded and not include tokens.
- POST `/v1/plugin/disconnect` plugin bearer `{sessionId}` → `{revoked:true}`

## Methods

Read:
- `scene.children` `{root:StudioRoot,ref?:InstanceRef,limit?:number}` → `{items:Node[],truncated:boolean}` max 200. Node `{ref,name,className,childCount}`. root required; ref optional selects parent within root.
- `scene.inspect` `{ref}` → `{ref,name,className,properties:object,childCount}`. Explicit property allowlist, never every property or Source automatically.
- `scene.search` `{root,query,limit?:number}` → `{items:Node[],truncated:boolean}` bounded BFS max 5000 inspected, 200 results. Case-insensitive name contains, query nonempty.
- `selection.read` `{}` → `{items:Node[]}` only granted roots.
- `script.read` `{ref}` → `{ref,source:string}`. Use ScriptEditorService:GetEditorSource, current editor not stale saved Source.

Write:
- `scene.create` `{parent:InstanceRef,className,name,properties?:object}`. Only Folder, Model, Part, Script, LocalScript, ModuleScript. New scripts disabled, no arbitrary Source property; ModuleScript not executed by bridge. Validate all fields/properties **before** parent assignment. Result `{ref,mutation:{kind:'scene.create',ref,before:null,after:{properties:object}}}`; snapshot all supported fields after create. New ownership marker is private session registry, not trusted attributes. Record ChangeHistoryService change. Creation rollback only if still owned, supported properties exactly unchanged and zero children.
- `scene.update` `{ref,expected:object,properties:object}`. Explicit writable allowlist Name (except services), BasePart Size/Position/Color/Anchored/CanCollide/Transparency/Material. Tagged values e.g `{type:'Vector3',value:[x,y,z]}`, Color3 channels [0,1], Material allowlisted string. expected must cover every changed property, compare first. Result `{ref,mutation:{kind:'scene.update',ref,before:{properties:object},after:{properties:object}}}`.
- `script.update` `{ref,expectedSource:string,source:string}`. Exact baseline inside UpdateSourceAsync callback; no yield in callback. Reread editor afterwards. If concurrent conflict, refuse, never overwrite. Receipt `{ref,mutation:{kind:'script.update',ref,before:{source:string},after:{source:string}}}`.
- `scene.restore` `{receiptCommandId,mutation:MutationReceipt}` trusted daemon-built. Reuse exact after comparison. No reverse execution of arbitrary Lua. Result `{restored:true,ref}`. A failed partial mutation must return failure with `result` recovery details (not claim rollback success), and block unsafe retries.

No delete endpoint in v1. Services cannot be renamed/reparented/destroyed. No user input can call a function/property outside allowlists. Plugin never auto-publishes or starts play. Every mutation must require explicit write grant and plugin edit state. Dirty editor conflicts are a first-class error.

## Worker acceptance

Plugin: deterministic build creates local `.rbxm`, source hierarchy, documented install/fixture steps; no live installation/place modification without parent coordination. Tests inspect generated bundle and XML, plus fixture instructions; do not claim native runtime verified until actually tested.
MCP: official SDK stdio, typed per-method tools over daemon, bounded polling with timeout and no automatic mutation retry. Connection config is project-local output, no home settings/credentials read. A tool timeout returns command ID and ambiguous status, not false failure. Read/write descriptions distinguish approvals.
UI: genuine pairing/session/receipt flows and visible read-only/writes state, exact session choice, restore preview/current-state guard warning. Untrusted text via textContent. No default writable pairing or inferred target. No mock account state.
Blender: independent worker supervision, actual capability/CLI evidence; deterministic local asset manifests and exports; no external upload, no claiming process isolation is a sandbox. Parent connects endpoints next.
