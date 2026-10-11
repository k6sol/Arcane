# Arcane — implementation roadmap and release gates
Version 1.2 · 11 October 2026. Milestones below are not completed. The experimental skill pack/offline helper and a buildable provider-connection workspace/lab now exist. Native metadata, exact preference saving and local HTTP boundaries are tested; Studio/plugin, inference and packaged desktop gates remain open. See [current provider slice](PROVIDER_NATIVE_FEATURES.md).

## 1. Build strategy

Build a reliable tool platform before a large chat interface. The first useful product is an Arcane plugin plus a local daemon/MCP server that an existing coding client can use. Own-model chat, asset production, agents and cloud services attach to the same contracts later.

The critical path is exact Studio targeting → safe edits → real tests → asset import proof. A polished app cannot compensate for overwriting an open script or importing a weapon backwards. Cloud accounts, billing and a public skill marketplace are not on the first-release critical path.

Use `FEATURE_CATALOG.csv` as the feature backlog and `TECHNICAL_SPEC.md` as the contract reference. Stage names M0–M10 are milestones, not calendar months. A feature moves from planned to implemented only with its own code and evidence; stage completion does not automatically complete every stretch item.

## 2. Milestones

### M0 — repository and capability proofs

Deliver:
- A TypeScript workspace with desktop, daemon, protocol and core packages; Luau plugin source and Rojo build; lint/type/test/build commands; CI with no production credentials.
- An architecture decision record, error taxonomy, protocol fixtures and disposable Studio test place.
- A recorded inventory of actual Studio MCP capabilities and version/target semantics.
- Minimal experiments for editor-aware script changes and supported model import/update mapping. Do not build a full asset interface before proving the upload route.

Gate: a clean checkout builds, tests and produces a plugin artifact. The bridge can identify two Studio windows without guessing. Import proof records the returned container/object IDs, ownership requirements and unresolved limitations. Missing capabilities have an explicit fallback or disabled state.

### M1 — plugin pairing, read tools and external MCP

Deliver:
- Loopback daemon with authenticated pairing, short-lived codes, revocation and session identity.
- Dockable plugin panel with connection/target/permission status and disconnect control.
- MCP entrypoint with health, capabilities, hierarchy, selection, instance reads and bounded script reads.
- Structured jobs/events, SQLite migrations and a minimal desktop connection/log view.
- Integrate the existing `arcane-studio-context` entrypoint with this small tool surface; evaluate it before approving a default. Preserve the existing offline helper/tests rather than generating a replacement pack.

Gate: pair, read the selected object and script, disconnect and reconnect in real Studio. Expired/reused codes and invalid sessions are rejected. Two windows of one place remain distinct. Search results are bounded and paginated. No read operation changes the place.

### M2 — safe code and scene changes

Deliver:
- Script checkout, unified diff, expected hash and editor-aware commit.
- Typed create/update/move operations, explicit delete previews, stable handles and approved-root checks.
- Task-scoped ChangeHistory recordings, snapshots and selective restoration.
- Policy classes, durable command receipts and single-writer fencing.
- External-client script editing, code search and scene edits, with source-control coexistence.

Gate: an open-buffer manual edit wins against a stale proposal; both versions remain available. Replaying a delivered command does not create another object. A mid-batch failure reports exactly what changed. Restoring a task preserves later unrelated edits or reports a conflict. Unauthorized roots and old-session writes are rejected.

### M3 — tests, screenshots and useful local alpha

Deliver:
- Built-in Studio MCP adapter for supported edit/test execution, play/stop, client/server contexts, input and viewport capture.
- Declarative test steps with explicit expected results; cancellation and teardown.
- Revision-bound logs/screenshots/reports, output filtering, bounded debugging/retest loops.
- External-client setup instructions and a local settings/diagnostic page.
- Reviewed and behavior-evaluated context, safe-edit, debugging, remote-security and QA skills from the original pack. Implement disposable fixtures and a budgeted runner; definition-only JSON is not evidence.
- Progressive skill discovery/loading for external clients with exact hashes, project rules and a context cap; reviewed supported client setup without replacing unrelated configuration.

Gate: create a test door in a disposable fixture, edit it, run a real proximity interaction, assert the result and restore it. Repeat with a script conflict, a runtime error, disconnect and cancelled test. No input stays held and no test lease survives cleanup. Unsupported multiplayer/capture capabilities remain labelled, not simulated as real results.

Release: **local alpha**. Useful with an external agent; no own-chat or paid-service requirement.

### M4 — integrated chat and own task engine

Deliver:
- Project/chat navigation, attachments, plan/build/debug modes, history and a task timeline.
- Provider-neutral model adapter, one real personal-API provider, credential storage and spend/iteration limits.
- Evaluate an eligible supported direct-plan adapter as a separate access mode; own authorized credentials, current provider contract and no unrequested API fallback. External-client mode remains available if eligibility is absent.
- Streaming responses, complete-argument tool validation, pause/cancel/steering, context budgets and durable artifacts.
- Diff, source, test and asset panels; project memory grounded in files and versions.

Gate: the same inspect/edit/test workflow succeeds through Arcane chat. Interrupted inference cannot silently rerun a chargeable request. Tasks stop on policy/budget limits and explain remaining work. Renderer code never receives inference credentials. External MCP mode still works without a provider key. Any advertised direct-plan mode has genuine authorization/completion/revocation evidence, correct usage labels and current eligibility review; otherwise it stays unavailable.

### M5 — Blender modelling and previews

Deliver:
- Headless supervised Blender jobs with workspaces, logs, timeouts, process cleanup and checkpoints.
- Asset briefs, reference views, blockout review, geometry validators, UV/material pipeline and export presets.
- Render turntables/contact sheets and browsable artifact history.
- Original/adapted Blender skills after licence review; optional third-party bridges only behind explicit adapters.

Gate: build a simple asymmetric prop and the Hunted cola workstation, render them, validate geometry and export. Kill Blender during a job and recover from the last genuine checkpoint. Task outputs stay within the job's allowed paths. Default worker design must not be advertised as a secure sandbox for arbitrary hostile Python.

### M6 — Roblox asset import, rigs and animations

Deliver:
- Creator ownership selection, credentials/OAuth where actually supported, upload plans, async operations and moderation states.
- Model/package insertion with deterministic object mapping, changed-object updates and material checks.
- R6/R15/custom Motor6D rig serialization and conversion; supported clip export/local fallback; grips and attachment mapping.
- Import inspection, collision/LOD checks, animation preview and publish controls.

Gate: the same logical asset updates without duplicate models and without deleting gameplay children. Scale, asymmetric axis fixture and materials match in Studio. Neutral pose and a short weapon action pass on each advertised rig type. Publishing failure preserves local work. An uploaded ID is not reported as usable until permission/loading checks pass.

Release: **creator beta** with integrated chat and a tested asset subset, not a promise of every rig/format combination.

### M7 — coordinated agents and advanced workflows

Deliver:
- Scoped read-only analysis agents; serial merge/writer leases; worktree isolation for filesystem tasks where applicable.
- Task graph, per-agent artifacts, model/budget allocation, conflict detection and review/merge evidence.
- Structured multiplayer/device testing when the backend supports it; performance measurement and visual comparisons.
- Animation editing, scene kits, approved asset search, template authoring and broadcast packaging.

Gate: agents working on different modules do not overwrite manual edits; competing scene changes wait or conflict safely. Agent failure does not mark the parent successful. Multiplayer reports prove separate client contexts. Max parallelism never means unbounded spend or concurrent mutation of one place.

### M8 — commercial cloud, billing and collaboration

Deliver:
- Accounts, teams, invite roles, opt-in sync and explicit data-retention controls.
- Managed inference gateway, task reservations, append-only usage ledger, plans/quotas and payment webhooks.
- Roblox OAuth and creator-resource selection with minimum verified scopes; no scraped cookies.
- Operator/support interface, abuse/rate controls, incident and deletion workflows.

Gate: duplicate webhooks never grant credits twice; unknown provider outcomes reconcile instead of charging twice. Team access is tested negatively. Personal keys are never synced. Revoked access cannot read a cached cloud artifact. Spending and service cost are visible and bounded.

### M9 — distribution and production hardening

Deliver:
- Signed Windows installer/updates, plugin compatibility matrix, safe migrations and recovery tools.
- Security review of local transport, IPC, untrusted previews, subprocesses, publishing and credentials.
- Accessibility, diagnostics, redacted support bundles and a documented support process.
- Dependency/licence notices, changelog, release channels and rollback drill.

Gate: clean-machine install, upgrade, failed upgrade, restart and uninstall pass. User projects remain intact. Debug archives exclude credentials and source by default. Critical reconnect/replay/restore tests have no open severe failures. Public launch depends on these gates, not just on the feature checklist.

### M10 — expansion after measured demand

Candidates: macOS parity, remote asset workers, approved team skill catalogues, additional model adapters, more media workflows and a permission-scoped extension SDK. Add only after support load, reliability and unit economics are measured. A third-party marketplace is optional, not required for parity with the useful workflow.

## 3. Minimum release boundaries

| Release | Required | Explicitly not required |
|---|---|---|
| Local alpha | M0–M3 core gates; real external-client workflow | Own model chat, cloud accounts, asset generation, billing |
| Creator beta | M4–M6 tested subset and installer usable by testers | Arbitrary rig parity, untested cloud workers, public marketplace |
| Commercial release | M8–M9 gates plus stable core/asset workflows | Every M7/M10 stretch feature |

Each release has a capability list. Disable unfinished tools instead of shipping plausible fake responses. A limitation disclosed in the UI is preferable to a silent failure.

## 4. Hunted acceptance scenarios

Use copies of the owner's project or purpose-built fixtures, not the live production place, for destructive tests.

1. **Code:** repair a round-state bug; inspect modules/remotes; compare the patch; verify disconnect handling and the original repro.
2. **Cola workstation:** preserve pickup → fill → pressure seal → approved/rejected flow; separate moving levers/gauge/rollers; import and update without replacing its scripts.
3. **Room:** place eight numbered workstations with readable routes and measured clearance; compare reference views; preserve lighting/geometry outside the task scope.
4. **Shiv:** match approved silhouette, arm/weapon grip, action animation and breakable parts; test actual authoritative hit detection rather than only a render.
5. **Broadcast:** build a timed image/audio package and Roblox playback manifest; check distinct text lines, existing classic item sounds and first-news voice. Respect Hunted's no-video-upload project rule. Do not reupload the old six ads without an explicit new request.
6. **Recovery:** interrupt one code task and one asset import; restart and reconcile without duplicate scripts, models or uploads.

These are product acceptance tasks, not permission to implement or publish Hunted changes during Arcane planning.

### General-game acceptance, equally important

- **Obby:** responsive jump/checkpoint/failure/retry on advertised devices; no duplicated reward or stale-stage reset.
- **Tycoon/simulator:** owner-safe production, meaningful upgrade choices, load/save failure and measured progression; no client-granted currency.
- **Cozy/social:** coherent bright scene, useful interaction/UI, avatar fit, safe text/party flow; no inherited horror or combat rules.
- **Racing:** physical controls, line choice, lap/reset/seat ownership and repeated retry; not a timer over an unrelated GUI task.
- **Combat:** readable attacks/counterplay, server-owned hit outcomes, grip/animation and observer/latency cases.
- **Puzzle:** distinct decisions, solvability, cooperative roles and predictable reset without spoilers or broken states.

Compare baseline and skill-assisted work on the same starting slice/model/tools. Record correctness, human corrections, actual available usage and context bytes. Ask real players about confusion, responsiveness and choices. Do not use agent ratings as proof of fun or commercial potential. Hunted-specific rules remain in project memory.

## 5. Risk register and early experiments

| Risk | Early proof / mitigation |
|---|---|
| Studio API/tool availability changes | Runtime capability discovery, compatibility fixtures and isolated adapters |
| Open script overwritten | Editor-source read plus expected version checked inside the update callback |
| Plugin recordings not full transactions | Per-operation receipts, before/after values, partial-result reporting and restore conflicts |
| Unsupported arbitrary mesh upload | Model-format PoC first; preserve actual returned containers/IDs and avoid fabricated endpoint assumptions |
| Coordinate/rig errors | Asymmetric static fixture, separate rig basis fixtures, neutral pose and grip comparisons |
| Long jobs fail/repeat | Persist operation IDs, checkpoint/reconcile before retrying, idempotency and fenced leases |
| Huge context and model spend | Bounded retrieval, progressive skill loading, step/spend limits and per-task usage |
| Concurrent agents corrupt place | Read-only parallel analysis plus one mutation owner; reviewed merge |
| Weak imported skills | Individual review, source pins, licence checks and baseline evaluations |
| Commercial support overwhelms owner | Small alpha first, redacted diagnostics and measured reliability before selling |

## 6. Effort and operating economics

Original planning estimates for one experienced full-time builder: local alpha roughly 4–8 focused weeks; integrated chat/asset beta another 8–16; commercial/security/distribution work another 8–16 or more. The small implemented lab is not evidence that these broader milestones are finished or faster. Estimates are not commitments or measured productivity. A first-time platform builder or difficult upload/animation constraints can take substantially longer. Model assistance does not remove integration, testing or support work.

Reduce scope before reducing safety. If only the local MCP/plugin workflow is needed for Hunted, M0–M3 can be the whole first product. Do not pay for a hosted multi-user system before proving local use.

For each managed task, measure:

    variable cost = provider usage + media generation + worker compute
                    + storage/egress attributable to the task + payment costs
    gross margin = revenue allocated to task - variable cost

Use provider-reported input/output/cached usage and current pricing configuration, not guessed prices. Include failed/retried jobs, refunds and support in business forecasting. Personal-API and external-client modes have different cost responsibilities and must be labelled.

Compare equivalent completed tasks against the current workflow by cost, elapsed time, required corrections and result quality. No fixed savings percentage or RoPilot-equivalent claim is justified yet. Price a commercial service only after measuring representative code, model, animation and testing workloads.

## 7. Next implementation slice

Implement M0 and the read-only portion of M1 first, following `BUILD_PROMPT.md`. Finish a buildable plugin, authenticated local pairing, exact target identity, hierarchy/selection/script reads and external MCP health. Test in a disposable place. Keep scope narrow enough to diagnose the full path end to end before adding writes or Blender.
