import { z } from 'zod';

export const SCENARIO_LIMITS = Object.freeze({ steps: 8, targets: 4, runtimeMs: 3000,
  wireBytes: 4 * 1024 * 1024, imageBytes: 2 * 1024 * 1024, imageDimension: 4096, imagePixels: 8 * 1024 * 1024 });
const id = z.string().regex(/^[A-Za-z0-9_-]{1,64}(?![\s\S])/);
const hash = z.string().regex(/^[a-f0-9]{64}(?![\s\S])/);
const name = z.string().min(1).max(100).refine(value => !/[\u0000-\u001f\u007f-\u009f\ud800-\udfff]/u.test(value));
export const scenarioKey = z.enum(['W', 'A', 'S', 'D', 'E', 'F', 'Space']);
export const scenarioTargetSchema = z.strictObject({ id, root: z.literal('LocalPlayer.PlayerGui'),
  segments: z.array(name).min(1).max(8), className: z.enum(['TextButton', 'ImageButton', 'TextLabel', 'Frame']) });
export const scenarioStepSchema = z.discriminatedUnion('kind', [
  z.strictObject({ id, kind: z.literal('hold-key'), key: scenarioKey, holdMs: z.number().int().min(25).max(1000) }),
  z.strictObject({ id, kind: z.literal('click-gui'), targetId: id }),
  z.strictObject({ id, kind: z.literal('assert-displacement'), minimumStuds: z.number().min(0.1).max(32) }),
  z.strictObject({ id, kind: z.literal('assert-gui'), targetId: id, property: z.literal('Visible'), equals: z.boolean(), withinMs: z.number().int().min(25).max(1000), requireTransition: z.boolean().default(true) }),
  z.strictObject({ id, kind: z.literal('assert-text'), targetId: id, equals: name, withinMs: z.number().int().min(25).max(1000), requireTransition: z.boolean().default(true) }),
  z.strictObject({ id, kind: z.literal('assert-gui-layout'), targetId: id, minimumWidth: z.number().int().min(1).max(4096),
    minimumHeight: z.number().int().min(1).max(4096), withinMs: z.number().int().min(25).max(1000) }),
]);
const ref = z.strictObject({ instanceId: z.string().min(1).max(256), sessionId: z.string().min(1).max(256),
  root: z.enum(['Workspace', 'ReplicatedStorage', 'ServerScriptService', 'ServerStorage', 'StarterGui', 'StarterPlayer', 'Lighting']),
  pathSegments: z.array(z.string().max(256)).max(64), className: z.string().min(1).max(256) });
export const scenarioTemporaryEditSchema = z.strictObject({ id, ref,
  expected: z.record(z.string(), z.json()), properties: z.record(z.string(), z.json()) });
export const scenarioPlanSchema = z.strictObject({ version: z.literal(1), runtimeBudgetMs: z.number().int().min(100).max(SCENARIO_LIMITS.runtimeMs),
  targets: z.array(scenarioTargetSchema).max(SCENARIO_LIMITS.targets), steps: z.array(scenarioStepSchema).min(1).max(SCENARIO_LIMITS.steps),
  capture: z.strictObject({ required: z.boolean() }), temporaryEdits: z.array(scenarioTemporaryEditSchema).min(1).max(4).optional(),
}).superRefine((plan, context) => {
  const reject = (message: string) => context.addIssue({ code: 'custom', message });
  if (new Set(plan.targets.map(target => target.id)).size !== plan.targets.length ||
      new Set(plan.steps.map(step => step.id)).size !== plan.steps.length ||
      new Set(plan.temporaryEdits?.map(edit => edit.id)).size !== (plan.temporaryEdits?.length ?? 0)) reject('Duplicate scenario identity.');
  let budget = 0;
  for (const step of plan.steps) {
    if ('targetId' in step) {
      const target = plan.targets.find(target => target.id === step.targetId);
      if (!target || step.kind === 'click-gui' && !['TextButton', 'ImageButton'].includes(target.className) ||
          step.kind === 'assert-text' && !['TextButton', 'TextLabel'].includes(target.className)) reject('Wrong scenario target.');
    }
    budget += step.kind === 'hold-key' ? step.holdMs : 'withinMs' in step ? step.withinMs : step.kind === 'click-gui' ? 50 : 0;
  }
  if (budget > plan.runtimeBudgetMs) reject('Scenario waits exceed the admitted runtime budget.');
  if (Buffer.byteLength(JSON.stringify(plan)) > 16 * 1024) reject('Scenario exceeds its input budget.');
});
export type ScenarioPlan = z.infer<typeof scenarioPlanSchema>;
const edge = z.number().finite().min(-16384).max(16384);
export const scenarioLayoutRectSchema = z.strictObject({left:edge,top:edge,right:edge,bottom:edge})
  .refine(rect=>rect.right>=rect.left&&rect.bottom>=rect.top&&rect.right-rect.left<=16384&&rect.bottom-rect.top<=16384,'Invalid layout rectangle.');
export const scenarioLayoutSchema = z.strictObject({coordinateSpace:z.literal('CoreUISafeInsets'),target:scenarioLayoutRectSchema,
  safeArea:scenarioLayoutRectSchema.refine(rect=>rect.left===0&&rect.top===0&&rect.right>0&&rect.bottom>0,'Invalid core safe area.'),
  clips:z.array(scenarioLayoutRectSchema).max(8),visibleChain:z.boolean(),
  viewport:z.strictObject({width:z.number().finite().positive().max(16384),height:z.number().finite().positive().max(16384),units:z.literal('RobloxUIOffset')})});
export type ScenarioLayout = z.infer<typeof scenarioLayoutSchema>;
/** Geometry uses one documented GUI coordinate space. Camera UI-offset units
 * are context only and never participate in rectangle arithmetic. */
export function scenarioLayoutPasses(minimumWidth:number,minimumHeight:number,layout:ScenarioLayout):boolean {
  const target=layout.target;
  return layout.visibleChain&&target.right-target.left>=minimumWidth&&target.bottom-target.top>=minimumHeight&&
    [layout.safeArea,...layout.clips].every(rect=>target.left>=rect.left&&target.top>=rect.top&&target.right<=rect.right&&target.bottom<=rect.bottom);
}
export const scenarioStepResultSchema = z.strictObject({ id, kind: z.enum(['hold-key', 'click-gui', 'assert-displacement', 'assert-gui', 'assert-text','assert-gui-layout']),
  outcome: z.enum(['passed', 'failed', 'not_run']), expected: z.union([z.boolean(), z.number().finite(), z.string().max(256)]),
  observed: z.union([z.boolean(), z.number().finite(), z.string().max(256), z.null()]),
  baseline: z.union([z.boolean(),z.string().max(256),z.number().finite()]).optional(),layout:scenarioLayoutSchema.optional() })
  .superRefine((row,context)=>{
    const reject=()=>context.addIssue({code:'custom',message:'Invalid layout observation.'});
    if(row.kind!=='assert-gui-layout'){if(row.layout!==undefined)reject();return;}
    if(row.baseline!==undefined||typeof row.observed!=='boolean'&&row.observed!==null&&row.observed!=='not-observed'||
      (row.layout!==undefined)!==(typeof row.observed==='boolean')||
      row.outcome==='passed'&&row.observed!==true||row.outcome==='not_run'&&(row.observed!==null&&row.observed!=='not-observed'))reject();
  });
export type ScenarioStepResult = z.infer<typeof scenarioStepResultSchema>;
/** Shared native and HTTP boundary check. Partial failures may retain the exact
 * prefix observed so far; a passing row must prove its sealed postcondition. */
export function scenarioEvidenceIssue(plan: ScenarioPlan, rows: readonly ScenarioStepResult[], passed: boolean,
  inputRelease: 'not_started'|'observed_released'|'unknown', code='OK'): string | null {
  if(rows.length>plan.steps.length || passed&&rows.length!==plan.steps.length)return 'Incomplete scenario step evidence.';
  if(code==='ASSERTION_FAILED'&&!rows.some(row=>row.outcome==='failed'))return 'Missing failed scenario assertion.';
  for(let index=0;index<rows.length;index++){
    const step=plan.steps[index]!,row=rows[index]!;
    if(row.id!==step.id||row.kind!==step.kind)return 'Wrong scenario step identity.';
    const expected=step.kind==='hold-key'?step.key+':'+step.holdMs:step.kind==='click-gui'?step.targetId:step.kind==='assert-displacement'?step.minimumStuds:
      step.kind==='assert-gui-layout'?'core-safe:'+step.minimumWidth+'x'+step.minimumHeight:step.equals;
    if(row.expected!==expected)return 'Wrong scenario step expectation.';
    if(step.kind==='assert-gui-layout'&&(row.layout&&row.observed!==scenarioLayoutPasses(step.minimumWidth,step.minimumHeight,row.layout)||
      code==='ASSERTION_FAILED'&&row.outcome==='failed'&&(row.observed!==false||!row.layout)))return 'Unmeasured or contradictory layout evidence.';
    if(step.kind==='assert-gui'&&row.baseline!==undefined&&typeof row.baseline!=='boolean'||
      step.kind==='assert-text'&&row.baseline!==undefined&&typeof row.baseline!=='string'||
      !['assert-gui','assert-text'].includes(step.kind)&&row.baseline!==undefined)return 'Wrong scenario baseline type.';
    if(passed&&row.outcome!=='passed')return 'Incomplete passing scenario evidence.';
    if(row.outcome==='passed' && (step.kind==='assert-displacement'&&(typeof row.observed!=='number'||row.observed<step.minimumStuds)||
      (step.kind==='assert-gui'||step.kind==='assert-text')&&(row.observed!==step.equals||step.requireTransition&&(row.baseline===undefined||row.baseline===step.equals))||
      (step.kind==='hold-key'||step.kind==='click-gui')&&row.observed!=='observed-released'))return 'Contradictory passing scenario evidence.';
  }
  if(passed&&inputRelease!==(plan.steps.some(step=>step.kind==='hold-key'||step.kind==='click-gui')?'observed_released':'not_started'))return 'Unverified scenario input release.';
  return null;
}
export const scenarioRuntimeReportSchema = z.strictObject({ version: z.literal(1), runId: id,
  scenarioDigest: hash, outcome: z.enum(['passed', 'failed', 'unsupported', 'unknown']),
  code: z.enum(['OK', 'ASSERTION_FAILED', 'UNSUPPORTED_TOOL', 'BINDING_CHANGED', 'TIMEOUT', 'EFFECT_UNKNOWN']),
  inputRelease: z.enum(['not_started', 'observed_released', 'unknown']),
  steps: z.array(scenarioStepResultSchema).min(1).max(SCENARIO_LIMITS.steps) });
export type ScenarioRuntimeReport = z.infer<typeof scenarioRuntimeReportSchema>;
export const scenarioCaptureSchema = z.strictObject({ id, sha256: hash, bytes: z.number().int().min(1).max(SCENARIO_LIMITS.imageBytes),
  mimeType: z.literal('image/png'), width: z.number().int().min(1).max(SCENARIO_LIMITS.imageDimension), height: z.number().int().min(1).max(SCENARIO_LIMITS.imageDimension),
  context:z.literal('unattested'),nativeAcceptance:z.literal(false) });
export type ScenarioCapture = z.infer<typeof scenarioCaptureSchema>;
export const scenarioReviewSchema = z.strictObject({ scenarioDigest: hash, subjectDigest: hash,
  state: z.enum(['not_started', 'running', 'passed', 'failed', 'unsupported', 'unknown']),
  inputRelease: z.enum(['not_started', 'observed_released', 'unknown']),
  temporary: z.enum(['not_started', 'running', 'restored', 'unknown']),
  steps: z.array(scenarioStepResultSchema).max(SCENARIO_LIMITS.steps),
  capture: scenarioCaptureSchema.nullable(), consoleCoverage: z.literal('ambiguous'),
});
export type ScenarioReview = z.infer<typeof scenarioReviewSchema>;
export interface ScenarioCaptureStore {
  save(runId: string, bytes: Buffer, image: {width: number; height: number}): Promise<ScenarioCapture>;
}
export const SCENARIO_ACTIONS = ['start', 'execute-approved-scenario', 'observe-state-and-console', 'capture-viewport', 'stop-owned-play', 'restore-temporary-changes'] as const;
