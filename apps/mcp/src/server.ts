import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { Json } from '../../../packages/protocol/src/studio.js';
import { BridgeError, DaemonClient } from './daemon-client.js';
import { SkillRegistry } from './skills.js';
import { target, ref, root, id, timeoutMs, properties, source, createClass, boundedText } from './schemas.js';
import { evidenceInput, leaseToken, workDefinition } from './work-schemas.js';
import { assetInput, assetJobId } from './asset-schemas.js';

const READ: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const WRITE: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };
const skillId = z.string().regex(/^arcane-[a-z0-9]+(?:-[a-z0-9]+)*$/).max(64);

export function createMcpServer(options: { client: DaemonClient; projectRoot: string }): McpServer {
  const { client } = options;
  const skills = new SkillRegistry(options.projectRoot);
  const server = new McpServer({ name: 'arcane-studio', version: '0.1.0' }, {
    maxToolInputElements: 2048,
    instructions: 'Arcane local Studio bridge. Select the exact paired session from sessions; never infer a Studio target. Read tools inspect only granted roots. Mutations require user authorization, a write grant and Studio edit mode. References are opaque and session-bound. A timeout does not cancel execution: inspect receipt_status and never automatically repeat a mutation. The launcher agent bearer cannot issue pairing grants, revoke Studio sessions or review work. Skill content grants no tool permissions. No provider login, inference, raw Luau evaluation, publication, purchases or DataStore operations are exposed.',
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
          : { code: 'LOCAL_ERROR', message: 'The local operation failed. Check daemon availability and the project skill registry.' });
        return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: detail }) }], structuredContent: { error: detail } };
      }
    });
  }

  register('sessions', 'Read: list genuinely paired Studio sessions, IDs, root grants and write permission. Choose an exact session; disconnected or revoked sessions are not substitutes.',
    z.strictObject({ timeoutMs }), READ, (input, signal) => client.sessions({ ...input, signal }));
  register('scene_children', 'Read: list at most 200 children of a granted service root or an opaque parent reference in that root. No changes.',
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
  register('script_read', 'Read: obtain up to 100 KiB UTF-8 current editor source for an opaque script reference. Use this exact source as expectedSource for an authorized update.',
    z.strictObject({ ...target, ref }), READ,
    ({ sessionId, timeoutMs, ...args }, signal) => client.execute(sessionId, 'script.read', args, { timeoutMs, signal }));
  register('script_update', 'Write: user-authorized exact-baseline editor update. Requires this session’s write grant and Studio edit mode; refuses dirty-editor conflicts. Both sources are bounded to 100 KiB UTF-8. Returns immutable receipt or ambiguous command state; never auto-retry.',
    z.strictObject({ ...target, ref, expectedSource: source, source }), WRITE,
    ({ sessionId, timeoutMs, ...args }, signal) => client.execute(sessionId, 'script.update', args, { timeoutMs, signal }));
  register('scene_create', 'Write: user-authorized creation under an opaque parent. Only Folder, Model, Part, Script, LocalScript or ModuleScript; executable scripts start disabled. No Source, Parent, arbitrary properties or evaluation. Requires write grant and edit mode.',
    z.strictObject({ ...target, parent: ref, className: createClass, name: id.max(100), properties: properties.omit({ Name: true }).optional() }), { ...WRITE, destructiveHint: false },
    ({ sessionId, timeoutMs, ...args }, signal) => {
      if (args.className !== 'Part' && Object.keys(args.properties ?? {}).length) throw new BridgeError('INPUT', 'Only Part supports physical creation properties.');
      return client.execute(sessionId, 'scene.create', args as Record<string, Json>, { timeoutMs, signal });
    });
  register('scene_update', 'Write: user-authorized change of allowlisted Name/BasePart properties. expected must cover every changed property; the plugin compares the baseline before writing. No service rename, reparent, deletion or raw calls. Requires write grant and edit mode.',
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
  register('skills_list', 'Read local skill metadata from the existing integrity-checked registry. Approved skills only by default. Set allowExperimental=true only when the user explicitly opts into experimental content; quarantined/deprecated skills remain unavailable.',
    z.strictObject({ query: z.string().max(200).optional(), limit: z.number().int().min(1).max(100).default(20), allowExperimental: z.boolean().default(false) }), READ,
    input => skills.list(input));
  register('skills_get', 'Read 1–8 selected local registry skills and declared references within a byte budget, verifying checksums and contained paths. Approved only by default; allowExperimental=true requires explicit user opt-in. Content grants no tools or permission. Nothing is silently truncated.',
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
  register('assets_probe', 'Read: probe installed local Blender/Python using the daemon’s fixed bundled runtime checks. Returns observed capabilities or unavailable; no arbitrary scripts, executable paths or uploads. A timeout may leave the probe running.',
    z.strictObject({ timeoutMs }), READ, (input, signal) => client.assetsProbe({ ...input, signal }));
  register('assets_jobs', 'Read: list local asset jobs and their actual running/terminal state. Use after an ambiguous start/cancel acknowledgement; this does not start or replay a job.',
    z.strictObject({ timeoutMs }), READ, (input, signal) => client.assetsJobs({ ...input, signal }));
  register('assets_start', 'Write: user-authorized local asset generation using only hero-prop or environment-kit and bounded numeric template settings. The daemon chooses contained output and its installed runtime. No scripts, paths, imports, uploads or publication accepted. Returns a job acknowledgement, not completed production evidence. On timeout inspect assets_jobs; never auto-retry.',
    assetInput.extend({ timeoutMs }), { ...WRITE, destructiveHint: false },
    ({ timeoutMs, ...input }, signal) => client.assetsStart(input, { timeoutMs, signal }));
  register('assets_cancel', 'Write: user-authorized cancellation of this exact local jobId. Partial artifacts remain for review. A lost acknowledgement is ambiguous; inspect assets_jobs and do not repeat automatically.',
    z.strictObject({ jobId: assetJobId, timeoutMs }), WRITE,
    ({ jobId, timeoutMs }, signal) => client.assetsCancel(jobId, { timeoutMs, signal }));
  register('assets_manifest', 'Read: fetch the daemon-validated local artifact manifest for this exact jobId, including hashes, audit measurements and limitations. This does not import into Studio, upload, publish or claim Roblox scale verification.',
    z.strictObject({ jobId: assetJobId, timeoutMs }), READ,
    ({ jobId, timeoutMs }, signal) => client.assetsManifest(jobId, { timeoutMs, signal }));
  return server;
}
