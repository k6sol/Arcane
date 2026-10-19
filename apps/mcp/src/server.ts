import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { Json } from '../../../packages/protocol/src/studio.js';
import { BridgeError, DaemonClient } from './daemon-client.js';
import { SkillRegistry } from './skills.js';
import { BUNDLED_GUIDANCE_POLICY, productInstructions, recommendSkills, sceneCreateDescription, sceneUpdateDescription, sceneBuildDescription, environmentDescription, SKILLS_RECOMMEND_TOOL, SKILL_ROUTER_LIMITS } from './skill-router.js';
import { compileSceneBuild, compileEnvironment, environmentShape, sceneBuildShape, type SceneBuildInput, compileEffectProps, effectCatalog, effectProps, compileGuiProps, guiCatalog, guiProps } from './scene-build.js';
import { validateProperties, validateGuiEditProperties, validateGuiBaseline, guiEditBaselineNames, EFFECT_CLASSES, isEffectClass, GUI_CLASSES, isGuiClass, ENVIRONMENT_PRESET_NAMES } from '../../../packages/core/src/studio-policy.js';
import { instanceRef } from '../../../packages/protocol/src/studio.js';
import { target, ref, root, id, timeoutMs, properties, sceneUpdateProperties, source, createClass, boundedText } from './schemas.js';
import { evidenceInput, leaseToken, workDefinition } from './work-schemas.js';
import { nativeAdoptGlbInput, assetInput, assetJobId, assetHistoryInput, nativeAssetHistoryInput, nativeAssetJobId } from './asset-schemas.js';
import { scenarioPlanSchema } from '../../../packages/studio-test-controller/src/scenario.js';
import { registerViewportTool } from './viewport-tool.js';
import { registerNativeAssetTools } from './native-asset-tools.js';
import { registerProceduralTools, registerProceduralPlaceTool } from './procedural-tools.js';
import { compactOutcome, serveCompactRefs, serveCompactToolList } from './token-lean.js';
import { TERRAIN_TOOL, TERRAIN_DESCRIPTION, terrainShape, compileTerrain } from './terrain-tool.js';

const READ: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const WRITE: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };
const skillId = z.string().regex(/^arcane-[a-z0-9]+(?:-[a-z0-9]+)*$/).max(64);

export function createMcpServer(options: { client: DaemonClient; projectRoot: string; skillRegistry?: SkillRegistry }): McpServer {
  const { client } = options;
  const assetScope = client.assetAudience === 'native-session'
    ? ' Native-session asset calls stay in the bearer’s exact project and Codex conversation scope, enforced by the daemon. Start/cancel require explicit host asset permission and an open admission window. Scoped reads require a sealed live bearer. The client routing mode grants no authority and establishes no originating-turn provenance.' : '';
  const scopedAssetJobId = client.assetAudience === 'native-session' ? nativeAssetJobId : assetJobId;
  // Injection is for trusted code fixtures only; --project remains a workspace.
  const skills = options.skillRegistry ?? new SkillRegistry();
  const server = new McpServer({ name: 'arcane-studio', version: '0.1.0' }, {
    maxToolInputElements: 100_000,
    instructions: productInstructions(),
  });

  function register<Shape extends z.ZodRawShape>(name: string, description: string, schema: z.ZodObject<Shape>, annotations: ToolAnnotations,
    handler: (input: z.output<z.ZodObject<Shape>>, signal: AbortSignal) => Promise<unknown>) {
    server.registerTool<z.ZodRawShape, z.ZodObject<Shape>>(name, { description, inputSchema: schema, annotations }, async (input, extra): Promise<CallToolResult> => {
      try {
        const data = compactOutcome(client.redact(await handler(input as z.output<z.ZodObject<Shape>>, extra.signal)) as Record<string, unknown>);
        const failed = data.terminal === true && ['failed', 'cancelled', 'needs_reconciliation'].includes(String(data.state));
        return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data, ...(failed ? { isError: true } : {}) };
      } catch (error) {
        const known = error instanceof BridgeError || (error instanceof Error && 'code' in error && typeof error.code === 'string' && /^[A-Z_]{1,64}$/.test(error.code));
        const detail = client.redact(known ? { code: (error as Error & { code: string }).code, message: (error as Error).message.slice(0,2048) }
          : { code: 'LOCAL_ERROR', message: 'The local operation failed. Check daemon availability and the bundled skill registry.' });
        return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: detail }) }], structuredContent: { error: detail } };
      }
    });
  }

  // Mirrors STUDIO_SESSION_LIVE_MS in packages/storage/src/studio-store.ts; the daemon's own `live` wins when it is supplied.
  const SESSION_LIVE_MS = 60_000;
  register('sessions', 'Read: paired Studio sessions with root grants, allowWrites, capabilities and live (plugin heard within 60 s). Reopened Studio leaves the old pairing listed with live=false (refused with SESSION_OFFLINE); choose the exact live session.',
    z.strictObject({ timeoutMs }), READ, async (input, signal) => {
      const listed = await client.sessions({ ...input, signal });
      return { sessions: listed.sessions.map(s => {
        const reported = (s as { live?: unknown }).live;
        return { ...s, live: typeof reported === 'boolean' ? reported : !s.revokedAt && Date.now() - Date.parse(s.lastSeenAt) <= SESSION_LIVE_MS };
      }) };
    });
  register('scene_children', 'Read: parentRef for the granted root or ref (even an empty Workspace) plus the first limit child nodes (max 200; truncated marks more). Use that parentRef as a write parent; never fabricate refs.',
    z.strictObject({ ...target, root, ref: ref.optional(), limit: z.number().int().min(1).max(200).default(50) }), READ,
    ({ sessionId, timeoutMs, ...args }, signal) => client.execute(sessionId, 'scene.children', args as Record<string, Json>, { timeoutMs, signal }));
  register('scene_inspect', 'Read: inspect allowlisted properties and child count of an opaque session reference. Script source is available only through script_read.',
    z.strictObject({ ...target, ref }), READ,
    ({ sessionId, timeoutMs, ...args }, signal) => client.execute(sessionId, 'scene.inspect', args, { timeoutMs, signal }));
  register('scene_search', 'Read: case-insensitive name search in a granted root (at most 5000 nodes inspected, limit returned up to 200; truncated marks the limit).',
    z.strictObject({ ...target, root, query: id.max(100).refine(value => value.trim().length > 0, 'Use a nonempty query.'), limit: z.number().int().min(1).max(200).default(50) }), READ,
    ({ sessionId, timeoutMs, ...args }, signal) => client.execute(sessionId, 'scene.search', args, { timeoutMs, signal }));
  register('selection_read', 'Read: return the current Studio selection only within this exact session’s granted roots.',
    z.strictObject(target), READ, ({ sessionId, timeoutMs }, signal) => client.execute(sessionId, 'selection.read', {}, { timeoutMs, signal }));
  register('script_read', 'Read: current editor source (up to 100 KiB) and Script/LocalScript enabled state for a script ref: the exact baselines for script_update and script_set_enabled.',
    z.strictObject({ ...target, ref }), READ,
    ({ sessionId, timeoutMs, ...args }, signal) => client.execute(sessionId, 'script.read', args, { timeoutMs, signal }));
  register('script_search', 'Read: find one literal single-line query in editor script text under a granted root or ref (caseSensitive false = ASCII folding). Returns up to limit matching lines with refs, 1-based line/byte columns and excerpts; fixed scan limits (5000 nodes, 128 scripts, 2 MiB) are reported as truncation/skipped. Excerpts are not an edit baseline: script_read before script_update. No regex or mutations.',
    z.strictObject({ ...target, root, ref: ref.optional(), query: z.string().min(1).max(256).refine(value => Buffer.byteLength(value, 'utf8') <= 256 && !/[\x00-\x1f\x7f]/.test(value) && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value), 'Use a literal single-line query of at most 256 UTF-8 bytes.'), limit: z.number().int().min(1).max(100).default(50), caseSensitive: z.boolean().default(true) }), READ,
    ({ sessionId, timeoutMs, ...args }, signal) => client.execute(sessionId, 'script.search', args as Record<string, Json>, { timeoutMs, signal }));
  register('script_update', 'Write: replace editor source given the exact expectedSource from script_read (each up to 100 KiB). Needs the write grant and edit mode; dirty-editor conflicts are refused. Returns a receipt or ambiguous state; never auto-retry.',
    z.strictObject({ ...target, ref, expectedSource: source, source }), WRITE,
    ({ sessionId, timeoutMs, ...args }, signal) => client.execute(sessionId, 'script.update', args, { timeoutMs, signal }));
  register('script_set_enabled', 'Write: enable or disable a Script/LocalScript using exact source and enabled baselines from script_read (new scripts start disabled). Enabling needs the host\'s pinned Luau syntax compiler and matching saved/editor source; empty, invalid or unsaved source is refused. Syntax verification is not a playtest. Write grant and edit mode; returns a receipt; never auto-retry.',
    z.strictObject({ ...target, ref, expectedSource: source, expectedEnabled: z.boolean(), enabled: z.boolean() }), WRITE,
    ({ sessionId, timeoutMs, ...args }, signal) => client.execute(sessionId, 'script.set_enabled', args, { timeoutMs, signal }));
  register('scene_delete', 'Write: remove objects the user asked to delete. Supply 1..64 exact refs in targets, or clearWorkspace:true to reset Workspace objects and all Terrain. The active Studio camera, engine roots and connection witness are protected. Works on existing scene content, including content Arcane did not create. Needs this session write grant and the updated plugin in Edit mode. One Studio Undo recording restores the removal; receipt_restore cannot. Large resets are bounded to 10000 top-level objects/100000 descendants. No automatic retry after an ambiguous outcome; check receipt_status and the scene.',
    z.strictObject({...target,targets:z.array(ref).min(1).max(64).optional(),clearWorkspace:z.literal(true).optional()}).refine(v=>(v.targets!==undefined)!==(v.clearWorkspace===true),'Choose targets or clearWorkspace, not both.'),WRITE,
    ({sessionId,timeoutMs,targets,clearWorkspace},signal)=>client.execute(sessionId,'scene.remove',clearWorkspace?{mode:'workspace'}:{mode:'refs',refs:targets as unknown as Json},{timeoutMs,signal}));
  register('scene_create', sceneCreateDescription() + ` Effects (plugin with scene.effects; parent a part, Attachment or Model): effect className plus fx, no properties. fx keys: ${effectCatalog()}. Beam/Trail Attachment0/1 take Attachment refs from this session. Audio: Sound in a part/Attachment (positional) or Model (global); SoundId only rbxassetid://<digits> the user gave or studio_asset_search (category Audio) returned, never invented; Sound.SoundGroup takes a SoundGroup ref; *SoundEffect classes go inside a Sound or SoundGroup. GUI (plugin with scene.gui): GUI className plus ui, no properties. ScreenGui in the StarterGui root; SurfaceGui on a part; BillboardGui on a part or Attachment; elements in a ScreenGui/SurfaceGui/BillboardGui or GuiObject; UI* modifiers in a GuiObject (UIListLayout/UIGridLayout/UIScale also in a layer GUI). ui keys: ${guiCatalog()}. For a whole screen use scene_build container ScreenGui.`,
    z.strictObject({ ...target, parent: ref, className: z.enum([...createClass.options, ...EFFECT_CLASSES, ...GUI_CLASSES]), name: id.max(100), properties: properties.omit({ Name: true }).optional(), fx: effectProps.optional(), ui: guiProps.optional() }), { ...WRITE, destructiveHint: false },
    ({ sessionId, timeoutMs, fx, ui, ...args }, signal) => {
      if (isGuiClass(args.className)) {
        if (args.properties || fx) throw new BridgeError('INPUT', 'GUI classes take ui, not properties/fx.');
        return client.execute(sessionId, 'scene.create', { ...args, properties: compileGuiProps(args.className, ui ?? {}) } as Record<string, Json>, { timeoutMs, signal });
      }
      if (ui) throw new BridgeError('INPUT', 'ui applies only to GUI classes.');
      if (isEffectClass(args.className)) {
        if (args.properties) throw new BridgeError('INPUT', 'Effect classes take fx, not properties.');
        const compiled = compileEffectProps(args.className, fx ?? {}, (value, label, kind) => {
          try { return { type: 'Ref', ref: instanceRef(value) as unknown as Json }; } catch { throw new BridgeError('INPUT', `${label} must be ${kind === 'attachment' ? 'an Attachment' : 'a SoundGroup'} ref from this session.`); }
        });
        return client.execute(sessionId, 'scene.create', { ...args, properties: compiled } as Record<string, Json>, { timeoutMs, signal });
      }
      if (fx) throw new BridgeError('INPUT', 'fx applies only to effect classes.');
      validateProperties(args.properties ?? {}, args.className, false);
      return client.execute(sessionId, 'scene.create', args as Record<string, Json>, { timeoutMs, signal });
    });
  register('scene_update', sceneUpdateDescription(),
    z.strictObject({ ...target, ref, expected: sceneUpdateProperties, properties: sceneUpdateProperties }), WRITE,
    ({ sessionId, timeoutMs, ...args }, signal) => {
      const changedKeys = Object.keys(args.properties);
      const keys = isGuiClass(args.ref.className) ? guiEditBaselineNames(args.ref.className, args.properties as Record<string, Json>) : changedKeys;
      if (!changedKeys.length || Object.keys(args.expected).length !== keys.length || keys.some(key => !Object.hasOwn(args.expected, key))) throw new BridgeError('INPUT', 'expected must cover the changed properties and any linked GUI font/constraint values; properties must be nonempty.');
      if (isGuiClass(args.ref.className)) {
        validateGuiEditProperties(args.properties, args.ref.className);
        validateGuiBaseline(args.expected, args.ref.className);
      } else {
        properties.parse(args.properties); properties.parse(args.expected);
      }
      return client.execute(sessionId, 'scene.update', args as Record<string, Json>, { timeoutMs, signal });
    });
  register('scene_build', sceneBuildDescription() + ' Effects: items with an effect className, name, in (group, part or Attachment key) and fx (keys listed on scene_create); Beam/Trail Attachment0/1 name earlier Attachment item keys. GUI (scene.gui): container ScreenGui or world GUIs; GUI className + ui; a ui prototype (e.g. a styled button) is stamped N times via use. Then only interaction logic, in a LocalScript via script_update.',
    z.strictObject({ ...target, parent: ref, ...sceneBuildShape }), { ...WRITE, destructiveHint: false },
    async ({ sessionId, timeoutMs, parent, ...input }, signal) => {
      const compiled = compileSceneBuild(input as SceneBuildInput, parent as Json);
      const outcome = await client.execute(sessionId, 'scene.build', compiled.args, { timeoutMs, signal });
      // Never echo the compiled hierarchy back into model context; the receipt summarises it.
      const command = outcome.command ? { ...outcome.command, args: { compiled: true, items: (compiled.args.items as Json[]).length, instances: compiled.instances } } : null;
      return { ...outcome, command, plannedInstances: compiled.instances, ...(compiled.scatter.length ? { scatter: compiled.scatter } : {}) };
    });
  register('environment_apply', environmentDescription() + ` With scene.effects: preset ${ENVIRONMENT_PRESET_NAMES.join('/')} (explicit sections override), technology, terrainDecoration, materials (MaterialVariants) and soundService (AmbientReverb, DistanceFactor, DopplerScale, RolloffScale). A setting Studio refuses rolls everything back and names the Properties-window step.`,
    z.strictObject({ ...target, ...environmentShape }), WRITE,
    ({ sessionId, timeoutMs, ...input }, signal) => client.execute(sessionId, 'environment.apply', compileEnvironment(input), { timeoutMs, signal }));
  register('receipt_status', 'Read: an existing command/receipt by commandId in any state. Never enqueues or replays; use after an ambiguous timeout.',
    z.strictObject({ commandId: id, timeoutMs }), READ,
    ({ commandId, timeoutMs }, signal) => client.receiptStatus(commandId, { timeoutMs, signal }));
  register('receipt_restore', 'Write: user-authorized undo of a succeeded mutation receipt commandId. The daemon builds the inverse; the plugin requires the exact after-state and refuses later edits. Write grant and edit mode; never repeat on timeout.',
    z.strictObject({ commandId: id, timeoutMs }), WRITE,
    ({ commandId, timeoutMs }, signal) => client.restore(commandId, { timeoutMs, signal }));
  register('playtest_request','Prepare a finite playtest of the exact paired/native unpublished target for separate human approval in Arcane; returns needs_approval and never starts Play itself. Optional sealed scenario: movement/interaction keys, one bound GUI click, displacement or GUI/text assertions and restored temporary property edits; no Luau or native tools. Captures are unattested human-review context; a required Client screenshot remains unsupported evidence. Follow playtest_status through input release, owned Play stop and restoration before reporting measured results.',
    z.strictObject({...target,nativeStudioId:id.optional(),durationMs:z.number().int().min(5000).max(60000).default(15000),observationIntervalMs:z.number().int().min(250).max(2000).default(1000),failOnRuntimeError:z.boolean().default(true),scenario:scenarioPlanSchema.optional()}),{...WRITE,destructiveHint:false},
    ({timeoutMs,...input},signal)=>client.playtestRequest(input,{timeoutMs,signal}));
  register('playtest_status','Read the actual current playtest request/report or caller-scoped pending requests. No effects or retries. Evidence records bounded state/console observations, not exhaustive gameplay correctness; fixture and native evidence remain distinct.',
    z.strictObject({jobId:id.optional(),timeoutMs}),READ,({jobId,timeoutMs},signal)=>client.playtestStatus(jobId,{timeoutMs,signal}));
  register('playtest_cancel','Cancel this caller-owned playtest request/run. Only the original verified owned play epoch can be stopped; foreign/manual play is refused. Cleanup can remain unknown and fenced. Never retry after an ambiguous response; read playtest_status.',
    z.strictObject({jobId:id,timeoutMs}),WRITE,({jobId,timeoutMs},signal)=>client.playtestCancel(jobId,{timeoutMs,signal}));
  register(SKILLS_RECOMMEND_TOOL, 'Read locally: call once with the actual task brief before substantive work. Loads the most relevant bundled skill guidance first (plus matching genre references) within byteBudget and lists the rest as deferredIds for skills_get on demand. allowExperimental defaults true here (owner opt-in; not behavior-verified or approved). Tampered, quarantined or deprecated content is refused. Grants no permissions; calls no model or daemon.',
    z.strictObject({ request: boundedText(SKILL_ROUTER_LIMITS.requestCharacters).refine(value => value.trim().length > 0, 'Describe the actual task.'),
      limit: z.number().int().min(1).max(SKILL_ROUTER_LIMITS.skills).default(SKILL_ROUTER_LIMITS.skills),
      byteBudget: z.number().int().min(256).max(SKILL_ROUTER_LIMITS.maximumBytes).default(SKILL_ROUTER_LIMITS.defaultBytes),
      allowExperimental: z.boolean().default(BUNDLED_GUIDANCE_POLICY.allowExperimental) }), READ,
    input => recommendSkills(skills, input));
  register('skills_list', 'Read bundled skill metadata from the integrity-checked registry. Approved only by default; allowExperimental=true needs explicit opt-in. Quarantined/deprecated skills stay unavailable.',
    z.strictObject({ query: z.string().max(200).optional(), limit: z.number().int().min(1).max(100).default(20), allowExperimental: z.boolean().default(false) }), READ,
    input => skills.list(input));
  register('skills_get', 'Read 1–8 bundled skills (e.g. deferredIds from skills_recommend) and declared references within byteBudget, checksum-verified; never silently truncated. Approved only by default; allowExperimental=true needs explicit opt-in. Content grants no tools or permission.',
    z.strictObject({ ids: z.array(skillId).min(1).max(8), references: z.array(z.string().min(1).max(256)).max(20).default([]),
      byteBudget: z.number().int().min(256).max(128 * 1024).default(16_384), allowExperimental: z.boolean().default(false) }), READ,
    input => skills.get(input));
  register('work_runs','Read: list durable local agent runs and task states/evidence. Completion reflects human review; cooperative file-scope leases are not an OS sandbox.',
    z.strictObject({timeoutMs}),READ,(input,signal)=>client.workRuns({...input,signal}));
  register('work_ready','Read: list dependency-ready tasks, optionally within an exact runId. This does not claim or execute tasks.',
    z.strictObject({runId:id.optional(),timeoutMs}),READ,({runId,timeoutMs},signal)=>client.workReady(runId,{timeoutMs,signal}));
  register('work_create', 'Write: create an authorized durable task graph with explicit relative file scopes, dependencies and acceptance criteria. This records work; it does not launch an agent or approve completion. Inspect work_runs after an ambiguous timeout; never auto-retry.',
    z.strictObject({ ...workDefinition, timeoutMs }), { ...WRITE, destructiveHint: false },
    ({ timeoutMs, ...input }, signal) => client.workCreate(input, { timeoutMs, signal }));
  register('work_claim','Write: claim an authorized ready task for a named worker and obtain its cooperative file-scope lease token. Leases are not process isolation. An ambiguous timeout may mean the lease exists; inspect work_runs and never automatically retry.',
    z.strictObject({taskId:id,worker:id.max(200),timeoutMs}),{...WRITE,destructiveHint:false},
    ({timeoutMs,...input},signal)=>client.workClaim(input,{timeoutMs,signal}));
  register('work_progress','Write: record bounded progress and extend a task lease using its returned leaseToken. This does not declare completion or approve evidence. Inspect task state after a timeout; no automatic replay.',
    z.strictObject({taskId:id,leaseToken,progress:boundedText(4000),timeoutMs}),{...WRITE,destructiveHint:false},
    ({timeoutMs,...input},signal)=>client.workProgress(input,{timeoutMs,signal}));
  register('work_submit','Write: submit 1–20 local project evidence paths and notes under your task lease. The daemon verifies containment and hashes files. Task enters needs_review; human panel owns acceptance. No review-approval tool is exposed. Inspect work_runs after an ambiguous wait; never repeat submission automatically.',
    z.strictObject({taskId:id,leaseToken,evidence:z.array(evidenceInput).min(1).max(20),timeoutMs}),{...WRITE,destructiveHint:false},
    ({timeoutMs,...input},signal)=>client.workSubmit(input,{timeoutMs,signal}));
  register('assets_probe', 'Read: probe installed local Blender/Python using the daemon’s fixed bundled runtime checks. Returns observed capabilities or unavailable; no arbitrary scripts, executable paths or uploads. A timeout may leave the probe running.' + assetScope,
    z.strictObject({ timeoutMs }), READ, (input, signal) => client.assetsProbe({ ...input, signal }));
  register('assets_jobs', 'Read: fetch one bounded local asset history page, preserving full recipes and observed state. limit is 1–64 (daemon default 32); use nextCursor as after for the next explicit page. No automatic pagination, start or replay. Use after an ambiguous acknowledgement.' + assetScope,
    (client.assetAudience === 'native-session' ? nativeAssetHistoryInput : assetHistoryInput).extend({ timeoutMs }), READ, (input, signal) => client.assetsJobs({ ...input, signal }));
  register('assets_start', 'Write: user-authorized local asset generation using hero-prop, environment-kit or a bounded custom-assembly JSON recipe (96 parts, 8 materials, 64 sockets; box/cylinder/cone/sphere/closed mesh). Custom materials support surface {profile:bark|stone|leaf|weathered,resolution:128|256|512}: original seamless PNG colour, tangent normal and packed metallic/roughness maps authored with UV0 in Blender. Shared normalization/topology/budget preflight runs before HTTP. Custom size/color come from the recipe; fixed-template defaults are unchanged. The daemon chooses contained output and its installed runtime. No scripts, paths, imports, uploads or publication accepted. Returns a job acknowledgement, not completed production evidence. On timeout inspect assets_jobs; never auto-retry.' + assetScope,
    assetInput.extend({ timeoutMs }), { ...WRITE, destructiveHint: false },
    ({ timeoutMs, ...input }, signal) => client.assetsStart(input, { timeoutMs, signal }));
  register('assets_cancel', 'Write: user-authorized cancellation of this exact local jobId. Partial artifacts remain for review. A lost acknowledgement is ambiguous; inspect assets_jobs and do not repeat automatically.' + assetScope,
    z.strictObject({ jobId: scopedAssetJobId, timeoutMs }), WRITE,
    ({ jobId, timeoutMs }, signal) => client.assetsCancel(jobId, { timeoutMs, signal }));
  register('assets_manifest', 'Read: fetch the daemon-validated local artifact manifest for this exact jobId, including assembly/source-request hashes, mesh geometry hashes, bounds, floor origins and measured PBR values, socket/export poses, audit measurements and limitations. This does not import into Studio, upload, publish or claim Roblox scale verification.' + assetScope,
    z.strictObject({ jobId: scopedAssetJobId, timeoutMs }), READ,
    ({ jobId, timeoutMs }, signal) => client.assetsManifest(jobId, { timeoutMs, signal }));
  registerViewportTool(server, client);
  registerNativeAssetTools(server, client);
  registerProceduralTools(server, client, assetScope);
  // Appended last in ARCANE_TOOL_NAMES, so it is registered after the procedural tools.
  register(TERRAIN_TOOL, TERRAIN_DESCRIPTION, z.strictObject({ ...target, ...terrainShape }), WRITE,
    ({ sessionId, timeoutMs, ...input }, signal) => client.execute(sessionId, 'terrain.generate', compileTerrain(input), { timeoutMs, signal }));
  if (client.assetAudience === 'native-session') {
    register('assets_adopt_glb','Write: adopt an existing owned project-relative GLB into a managed immutable chat asset for interactive preview. Requires the exact native project/conversation capture and explicit asset admission. Validates actual bounded GLB bytes, embedded image budgets and direct ordinary-file containment before copying; no links, URLs, Python/scripts or caller authority fields. Uses explicit adopted provenance, never bundled-Blender evidence. Engine import/upload remains unavailable pending safe conversion. The returned job acknowledgement is not engine acceptance. Inspect assets_jobs after ambiguity; never auto-retry.'+assetScope,
      nativeAdoptGlbInput, { ...WRITE,destructiveHint:false },
      (input,signal)=>client.assetsAdoptGlb(input,{signal}));
    register('assets_prepare_studio_import', 'Requires human Approve in the verified 3D preview. Prepare a bounded Studio import plan for this exact completed, conversation-bound asset jobId using verified generated bytes and trusted host target/observed-baseline selection. Requires explicit host asset permission and an open admission window. Returns prepared with engineVerification pending; no Studio execution, upload, insertion, publication or acceptance is established. Unconfigured target hooks fail unavailable; never invent a target or supply target, baseline, files or credentials. A timeout or invalid response establishes no verified plan; no automatic retry.' + assetScope,
      z.strictObject({ jobId: nativeAssetJobId, timeoutMs }), { ...WRITE, destructiveHint: false },
      ({ jobId, timeoutMs }, signal) => client.assetsPrepareStudioImport(jobId, { timeoutMs, signal }));
    register('assets_stage_studio_import', 'Stage CPU transfer packets for this exact completed, conversation-bound asset jobId through the trusted native host controller. Requires explicit host asset permission, an open admission window and exact writable Edit continuity selected by the host. Returns authoritative jobId/projectId, runId and the actual sealed CPU receipt: status staged, imported false, engineVerification pending, packet count/bytes, transfer digest and original command IDs. Project identity comes from the captured native host binding. No upload, insertion, publication, engine reconstruction or rights admission is established. Accepts only jobId and a bounded client wait; never supply target, bytes, account IDs, permission or credentials. A timeout, invalid response or late rejection is unknown and never auto-retried; the controller can continue after the client stops waiting. A genuinely fresh native operation may admit a separate CPU attempt only after the host verifies a changed paired session, plugin lifetime or Edit epoch; previous run/command evidence remains immutable, and no upload is replayed.' + assetScope,
      z.strictObject({ jobId: nativeAssetJobId, timeoutMs }), { ...WRITE, destructiveHint: false },
      ({ jobId, timeoutMs }, signal) => client.assetsStageStudioImport(jobId, { timeoutMs, signal }));
    register('assets_studio_staging_status', 'Read retained CPU staging status for this exact conversation-bound jobId. Returns the authoritative job/project envelope and latest retained run/packet command evidence, or stage null when no run is retained. receiptScope historical-cpu and currentBuffers unobserved make clear that a sealed receipt never proves buffers remain present after reconnect. engineVerification remains pending, imported false and retry false. Running, stopped or needs_reconciliation never establishes upload, insertion, reconstruction or permission to repeat staging. This read does not start, resume, cancel or retry work. Only jobId and a bounded client wait are accepted; never supply target, bytes, project, account IDs, rights or credentials.' + assetScope,
      z.strictObject({ jobId: nativeAssetJobId, timeoutMs }), READ,
      ({ jobId, timeoutMs }, signal) => client.assetsStudioStagingStatus(jobId, { timeoutMs, signal }));
    register('assets_reconstruct_studio_import','Write: reconstruct detached EditableMeshes from the original sealed CPU stage run for this exact conversation-bound jobId. The production host derives original source identities and target, admits one durable command, and the plugin consumes its actually retained receiver once under the same writable Edit epoch, session, plugin lifetime and source hash. Returns only source/count metadata with imported false and engineVerification pending. No mesh parenting, upload, publication, rights grant, rendering verification or native acceptance is established. Accepts only jobId and bounded wait; hashes, tickets, creator IDs, permissions and bytes cannot be supplied as authority. Lost, late-rejected or invalid acknowledgements are unknown; never repeat automatically. Inspect assets_studio_reconstruction_status.'+assetScope,
      z.strictObject({jobId:nativeAssetJobId,timeoutMs}),{...WRITE,destructiveHint:false},
      ({jobId,timeoutMs},signal)=>client.assetsReconstructStudioImport(jobId,{timeoutMs,signal}));
    register('assets_studio_reconstruction_status','Read historical detached reconstruction evidence for this exact conversation-bound jobId. Returns the original command state and matching receipt or null, with currentResources unobserved, imported false, engineVerification pending and retry false. A succeeded receipt never proves resources survived a reconnect/Play epoch or authorizes upload/insertion. This operation never allocates, resumes, repairs or retries anything.'+assetScope,
      z.strictObject({jobId:nativeAssetJobId,timeoutMs}),READ,
      ({jobId,timeoutMs},signal)=>client.assetsStudioReconstructionStatus(jobId,{timeoutMs,signal}));
    registerProceduralPlaceTool(server, client, assetScope);
  }
  serveCompactToolList(server);
  serveCompactRefs(server);
  return server;
}
