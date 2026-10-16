import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { Json } from '../../../packages/protocol/src/studio.js';
import { BridgeError, DaemonClient } from './daemon-client.js';
import { SkillRegistry } from './skills.js';
import { BUNDLED_GUIDANCE_POLICY, productInstructions, recommendSkills, sceneCreateDescription, sceneUpdateDescription, SKILLS_RECOMMEND_TOOL, SKILL_ROUTER_LIMITS } from './skill-router.js';
import { validateProperties } from '../../../packages/core/src/studio-policy.js';
import { target, ref, root, id, timeoutMs, properties, source, createClass, boundedText } from './schemas.js';
import { evidenceInput, leaseToken, workDefinition } from './work-schemas.js';
import { nativeAdoptGlbInput, assetInput, assetJobId, assetHistoryInput, nativeAssetHistoryInput, nativeAssetJobId } from './asset-schemas.js';
import { scenarioPlanSchema } from '../../../packages/studio-test-controller/src/scenario.js';

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
        const data = client.redact(await handler(input as z.output<z.ZodObject<Shape>>, extra.signal)) as Record<string, unknown>;
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
  register('sessions', 'Read: list paired Studio sessions, IDs, root grants, write permission and live (plugin heard from within the last 60 s). Reopening Studio leaves the old pairing listed with live=false; commands to it are refused with SESSION_OFFLINE. Choose an exact live session; non-live or revoked sessions are not substitutes.',
    z.strictObject({ timeoutMs }), READ, async (input, signal) => {
      const listed = await client.sessions({ ...input, signal });
      return { sessions: listed.sessions.map(s => {
        const reported = (s as { live?: unknown }).live;
        return { ...s, live: typeof reported === 'boolean' ? reported : !s.revokedAt && Date.now() - Date.parse(s.lastSeenAt) <= SESSION_LIVE_MS };
      }) };
    });
  register('scene_children', 'Read: return parentRef for the exact requested granted root/parent (including an empty Workspace), plus at most 200 child nodes. Reuse the actual parentRef for authorized scene_create; never fabricate root references. No changes.',
    z.strictObject({ ...target, root, ref: ref.optional(), limit: z.number().int().min(1).max(200).default(100) }), READ,
    ({ sessionId, timeoutMs, ...args }, signal) => client.execute(sessionId, 'scene.children', args as Record<string, Json>, { timeoutMs, signal }));
  register('scene_inspect', 'Read: inspect allowlisted properties and child count of an opaque session reference. Script source is available only through script_read.',
    z.strictObject({ ...target, ref }), READ,
    ({ sessionId, timeoutMs, ...args }, signal) => client.execute(sessionId, 'scene.inspect', args, { timeoutMs, signal }));
  register('scene_search', 'Read: case-insensitive name search in an explicitly granted root. At most 5000 nodes inspected and 200 returned; truncated indicates the limit.',
    z.strictObject({ ...target, root, query: id.max(100).refine(value => value.trim().length > 0, 'Use a nonempty query.'), limit: z.number().int().min(1).max(200).default(100) }), READ,
    ({ sessionId, timeoutMs, ...args }, signal) => client.execute(sessionId, 'scene.search', args, { timeoutMs, signal }));
  register('selection_read', 'Read: return the current Studio selection only within this exact session’s granted roots.',
    z.strictObject(target), READ, ({ sessionId, timeoutMs }, signal) => client.execute(sessionId, 'selection.read', {}, { timeoutMs, signal }));
  register('script_read', 'Read: obtain up to 100 KiB UTF-8 current editor source and Script/LocalScript enabled state for an opaque script reference. Use these exact baselines for an authorized update or activation. ModuleScripts have no enabled state.',
    z.strictObject({ ...target, ref }), READ,
    ({ sessionId, timeoutMs, ...args }, signal) => client.execute(sessionId, 'script.read', args, { timeoutMs, signal }));
  register('script_search', 'Read: search current editor script contents for one literal single-line query inside a granted root or its observed subtree ref. Case-sensitive by default; false uses ASCII case folding, not Unicode case folding. Returns at most 100 matching lines (one match per line), genuine refs, one-based line/UTF-8-byte columns and bounded excerpts. Fixed limits: 5000 nodes, 128 script reads, 2 MiB scanned source, 100 KiB per script and 256 KiB matched-item JSON. Truncation reasons and skipped scripts are explicit. This is a changing editor observation, not an atomic snapshot or update baseline; use script_read before editing. No regex, file writes, evaluation or mutations.',
    z.strictObject({ ...target, root, ref: ref.optional(), query: z.string().min(1).max(256).refine(value => Buffer.byteLength(value, 'utf8') <= 256 && !/[\x00-\x1f\x7f]/.test(value) && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value), 'Use a literal single-line query of at most 256 UTF-8 bytes.'), limit: z.number().int().min(1).max(100).default(50), caseSensitive: z.boolean().default(true) }), READ,
    ({ sessionId, timeoutMs, ...args }, signal) => client.execute(sessionId, 'script.search', args as Record<string, Json>, { timeoutMs, signal }));
  register('script_update', 'Write: user-authorized exact-baseline editor update. Requires this session’s write grant and Studio edit mode; refuses dirty-editor conflicts. Both sources are bounded to 100 KiB UTF-8. Returns immutable receipt or ambiguous command state; never auto-retry.',
    z.strictObject({ ...target, ref, expectedSource: source, source }), WRITE,
    ({ sessionId, timeoutMs, ...args }, signal) => client.execute(sessionId, 'script.update', args, { timeoutMs, signal }));
  register('script_set_enabled', 'Write: activate or disable a Script/LocalScript using its exact current source and enabled baseline from script_read. New scripts start disabled. Enabling (including restoring a previously disabled script) requires the trusted host pinned Luau syntax compiler and matching persisted/editor source; empty, invalid or unsaved source is refused. Syntax verification is not a playtest. Requires exact paired write scope and edit mode; returns a recoverable receipt. Never auto-retry on timeout.',
    z.strictObject({ ...target, ref, expectedSource: source, expectedEnabled: z.boolean(), enabled: z.boolean() }), WRITE,
    ({ sessionId, timeoutMs, ...args }, signal) => client.execute(sessionId, 'script.set_enabled', args, { timeoutMs, signal }));
  register('scene_create', sceneCreateDescription(),
    z.strictObject({ ...target, parent: ref, className: createClass, name: id.max(100), properties: properties.omit({ Name: true }).optional() }), { ...WRITE, destructiveHint: false },
    ({ sessionId, timeoutMs, ...args }, signal) => {
      validateProperties(args.properties ?? {}, args.className, false);
      return client.execute(sessionId, 'scene.create', args as Record<string, Json>, { timeoutMs, signal });
    });
  register('scene_update', sceneUpdateDescription(),
    z.strictObject({ ...target, ref, expected: properties, properties }), WRITE,
    ({ sessionId, timeoutMs, ...args }, signal) => {
      const keys = Object.keys(args.properties);
      if (!keys.length || Object.keys(args.expected).length !== keys.length || keys.some(key => !Object.hasOwn(args.expected, key))) throw new BridgeError('INPUT', 'expected must cover exactly every changed property, and properties must be nonempty.');
      return client.execute(sessionId, 'scene.update', args as Record<string, Json>, { timeoutMs, signal });
    });
  register('receipt_status', 'Read: look up an existing immutable command/receipt by commandId, including queued, dispatched, failed or needs_reconciliation states. This does not enqueue or replay work; use after an ambiguous timeout.',
    z.strictObject({ commandId: id, timeoutMs }), READ,
    ({ commandId, timeoutMs }, signal) => client.receiptStatus(commandId, { timeoutMs, signal }));
  register('receipt_restore', 'Write: user-authorized restoration from a succeeded mutation receipt commandId. The daemon constructs the inverse; the plugin requires the exact current after-state and refuses later-edit conflicts. Requires current write grant and edit mode. Do not supply an inverse or repeat on timeout.',
    z.strictObject({ commandId: id, timeoutMs }), WRITE,
    ({ commandId, timeoutMs }, signal) => client.restore(commandId, { timeoutMs, signal }));
  register('playtest_request','Prepare a finite Studio playtest for the exact paired/native unpublished target, with separate human approval in Arcane. An optional sealed scenario can hold movement/interaction keys, click one privately bound GUI target, assert displacement or GUI/text transitions, and restore approved temporary property edits. Source and editor revisions are observed by the host. Request data cannot supply Luau or native tools. Current captures are retained for human review with unattested context; a required Client screenshot remains unsupported evidence. Returns needs_approval; follow playtest_status through settled input release, owned Play stop, and restoration before reporting measured results.',
    z.strictObject({...target,nativeStudioId:id.optional(),durationMs:z.number().int().min(5000).max(60000).default(15000),observationIntervalMs:z.number().int().min(250).max(2000).default(1000),failOnRuntimeError:z.boolean().default(true),scenario:scenarioPlanSchema.optional()}),{...WRITE,destructiveHint:false},
    ({timeoutMs,...input},signal)=>client.playtestRequest(input,{timeoutMs,signal}));
  register('playtest_status','Read the actual current playtest request/report or caller-scoped pending requests. No effects or retries. Evidence records bounded state/console observations, not exhaustive gameplay correctness; fixture and native evidence remain distinct.',
    z.strictObject({jobId:id.optional(),timeoutMs}),READ,({jobId,timeoutMs},signal)=>client.playtestStatus(jobId,{timeoutMs,signal}));
  register('playtest_cancel','Cancel this caller-owned playtest request/run. Only the original verified owned play epoch can be stopped; foreign/manual play is refused. Cleanup can remain unknown and fenced. Never retry after an ambiguous response; read playtest_status.',
    z.strictObject({jobId:id,timeoutMs}),WRITE,({jobId,timeoutMs},signal)=>client.playtestCancel(jobId,{timeoutMs,signal}));
  register(SKILLS_RECOMMEND_TOOL, 'Read locally: automatically select and load relevant bundled skill guidance from the actual task brief, including matching declared genre references, within a byte budget. Call before substantive inspect/plan/build/verify work; the user need not select skill IDs or tools. The product owner opted into experimental guidance, so allowExperimental defaults true for this router only; states remain honest and no skill is promoted to behavior-verified or approved. Quarantined/deprecated, tampered or escaped content is refused. Returns loaded IDs/status/context and explicitly deferred items; grants no permissions, calls no model or daemon, and scans no project.',
    z.strictObject({ request: boundedText(SKILL_ROUTER_LIMITS.requestCharacters).refine(value => value.trim().length > 0, 'Describe the actual task.'),
      limit: z.number().int().min(1).max(SKILL_ROUTER_LIMITS.skills).default(SKILL_ROUTER_LIMITS.skills),
      byteBudget: z.number().int().min(256).max(SKILL_ROUTER_LIMITS.maximumBytes).default(SKILL_ROUTER_LIMITS.defaultBytes),
      allowExperimental: z.boolean().default(BUNDLED_GUIDANCE_POLICY.allowExperimental) }), READ,
    input => recommendSkills(skills, input));
  register('skills_list', 'Read bundled skill metadata from the existing integrity-checked registry. Approved skills only by default. Set allowExperimental=true only when the user explicitly opts into experimental content; quarantined/deprecated skills remain unavailable.',
    z.strictObject({ query: z.string().max(200).optional(), limit: z.number().int().min(1).max(100).default(20), allowExperimental: z.boolean().default(false) }), READ,
    input => skills.list(input));
  register('skills_get', 'Read 1–8 selected bundled registry skills and declared references within a byte budget, verifying checksums and contained paths. Approved only by default; allowExperimental=true requires explicit user opt-in. Content grants no tools or permission. Nothing is silently truncated.',
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
  register('assets_start', 'Write: user-authorized local asset generation using hero-prop, environment-kit or a bounded custom-assembly JSON recipe (96 parts, 8 materials, 64 sockets; box/cylinder/cone/sphere/closed mesh). Shared normalization/topology/budget preflight runs before HTTP. Custom size/color come from the recipe; fixed-template defaults are unchanged. The daemon chooses contained output and its installed runtime. No scripts, paths, imports, uploads or publication accepted. Returns a job acknowledgement, not completed production evidence. On timeout inspect assets_jobs; never auto-retry.' + assetScope,
    assetInput.extend({ timeoutMs }), { ...WRITE, destructiveHint: false },
    ({ timeoutMs, ...input }, signal) => client.assetsStart(input, { timeoutMs, signal }));
  register('assets_cancel', 'Write: user-authorized cancellation of this exact local jobId. Partial artifacts remain for review. A lost acknowledgement is ambiguous; inspect assets_jobs and do not repeat automatically.' + assetScope,
    z.strictObject({ jobId: scopedAssetJobId, timeoutMs }), WRITE,
    ({ jobId, timeoutMs }, signal) => client.assetsCancel(jobId, { timeoutMs, signal }));
  register('assets_manifest', 'Read: fetch the daemon-validated local artifact manifest for this exact jobId, including assembly/source-request hashes, mesh geometry hashes, bounds, floor origins and measured PBR values, socket/export poses, audit measurements and limitations. This does not import into Studio, upload, publish or claim Roblox scale verification.' + assetScope,
    z.strictObject({ jobId: scopedAssetJobId, timeoutMs }), READ,
    ({ jobId, timeoutMs }, signal) => client.assetsManifest(jobId, { timeoutMs, signal }));
  if (client.assetAudience === 'native-session') {
    register('assets_adopt_glb','Write: adopt an existing owned project-relative GLB into a managed immutable chat asset for interactive preview. Requires the exact native project/conversation capture and explicit asset admission. Validates actual bounded GLB bytes, embedded image budgets and direct ordinary-file containment before copying; no links, URLs, Python/scripts or caller authority fields. Uses explicit adopted provenance, never bundled-Blender evidence. Engine import/upload remains unavailable pending safe conversion. The returned job acknowledgement is not engine acceptance. Inspect assets_jobs after ambiguity; never auto-retry.'+assetScope,
      nativeAdoptGlbInput, { ...WRITE,destructiveHint:false },
      (input,signal)=>client.assetsAdoptGlb(input,{signal}));
    register('assets_prepare_studio_import', 'Prepare a bounded Studio import plan for this exact completed, conversation-bound asset jobId using verified generated bytes and trusted host target/observed-baseline selection. Requires explicit host asset permission and an open admission window. Returns prepared with engineVerification pending; no Studio execution, upload, insertion, publication or acceptance is established. Unconfigured target hooks fail unavailable; never invent a target or supply target, baseline, files or credentials. A timeout or invalid response establishes no verified plan; no automatic retry.' + assetScope,
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
  }
  return server;
}
