/// <reference lib="dom" />
import type {StudioTestReportSummary,StudioTestReportArchiveStatus} from '../../daemon/src/studio-test-report-store.js';

export interface PlaytestPanelOptions {
  root: HTMLElement;
  token: () => string;
  isSignedIn: () => boolean;
  transport?: typeof fetch;
  /** Explicit production opt-in; legacy facades make no history requests. */
  reports?: boolean;
  /** Actual project metadata and independent monotonic project/auth generations. */
  reportContext?: () => Readonly<{projectId:string;projectEpoch:number;authEpoch:number}> | null;
  /** The composer's Playtest switch. When it returns true, a request from the managed chat that first appeared while the
   * switch was on is approved automatically through the same route and digest a click uses. Omitted or false: never. */
  autoApprove?: () => boolean;
}
export interface PlaytestPanelController { stop(): void; refresh(): Promise<void> }

const RESPONSE_BYTES = 128 * 1024;
const POLL_MS = 2_000, AUTH_CHECK_MS = 250, TIMEOUT_MS = 15_000, VISIBLE_JOBS = 3;
const ACTIONS = ['start', 'observe-state-and-console', 'stop-owned-play'] as const;
const SCENARIO_ACTIONS=['start','execute-approved-scenario','observe-state-and-console','capture-viewport','stop-owned-play','restore-temporary-changes'] as const;
type Row = Record<string, unknown>;
type DisplayValue = string | number | boolean | DisplayValue[] | { [key: string]: DisplayValue };
interface ScenarioPlanView {
  runtimeBudgetMs:number;captureRequired:boolean;steps:readonly string[];
  temporaryChanges:readonly {target:string;changes:readonly string[]}[];
}
interface Job {
  id: string; targetName: string; state: 'needs_approval' | 'running' | 'complete' | 'cancelled';
  displayDigest: string; display: Readonly<Row>; scope: string; durationMs: number;
  consentExpiresAt: number; evidence: 'native' | 'fixture';
  /** Requested by a managed chat (an agent caller), not by a person in this panel. */
  agent: boolean;
  scenarioPlan?:ScenarioPlanView;
  review: { phase: string; outcome: string | null; code: string | null; cleanup: string; requiresHumanReview: boolean;
    scenario?: {state:string;inputRelease:string;temporary:string;steps:Row[];capture:{id:string;sha256:string;bytes:number}|null} };
}
function invalid(): never { throw new Error('Invalid playtest response'); }
/** A bounded non-200 reply that carried a fixed daemon error code (for example FENCED). */
class PlaytestRefusal extends Error { constructor(readonly code: string) { super('Invalid playtest response'); } }
export const PLAYTEST_REPAIR_COPY = Object.freeze({
  fenced: 'Playtests are paused: an earlier playtest didn’t finish cleanly, so Arcane kept its records. Stop any playtest still running in Studio, then repair. The earlier records are kept, not deleted.',
  button: 'Repair playtest records',
  confirm: 'Studio is stopped (Edit mode) · Repair now',
  done: 'Playtest records repaired. You can playtest again.',
  failed: 'Couldn’t repair the playtest records. Restart Arcane and try again.',
});
function object(value: unknown): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  return value as Row;
}
function keys(value: Row, required: readonly string[], optional: readonly string[] = []): void {
  if (required.some(key => !Object.hasOwn(value, key)) ||
      Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) invalid();
}
function text(value: unknown, maximum = 256): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]|[\ud800-\udfff]/u.test(value)) invalid();
  return value;
}
function integer(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) invalid();
  return value;
}
function attributeScalar(value:unknown):boolean|number|string{
  if(typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value)&&Math.abs(value)<=Number.MAX_SAFE_INTEGER)return value;
  if(typeof value!=='string'||value.length>128||new TextEncoder().encode(value).length>256||
    /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff\ud800-\udfff]/u.test(value))invalid();
  return value;
}
function attributeObserved(value:unknown,attributeName:unknown,expected:unknown,requireTransition:boolean):boolean{
  const measurement=object(value);keys(measurement,['context','subject','name','baseline','observed']);
  if(measurement.context!=='Client'||measurement.subject!=='LocalPlayer'||measurement.name!==attributeName)invalid();
  const read=(value:unknown)=>{const observation=object(value);
    if(observation.present===false){keys(observation,['present']);return observation;}
    if(observation.present!==true)invalid();keys(observation,['present','value']);attributeScalar(observation.value);return observation;};
  const baseline=read(measurement.baseline),observed=read(measurement.observed);
  return observed.present===true&&observed.value===expected&&(!requireTransition||baseline.present===false||baseline.value!==expected);
}
function layoutRect(value:unknown):{left:number;top:number;right:number;bottom:number}{
  const rect=object(value);keys(rect,['left','top','right','bottom']);
  for(const edge of Object.values(rect))if(typeof edge!=='number'||!Number.isFinite(edge)||Math.abs(edge)>16384)invalid();
  const {left,top,right,bottom}=rect as {left:number;top:number;right:number;bottom:number};
  if(right<left||bottom<top||right-left>16384||bottom-top>16384)invalid();return{left,top,right,bottom};
}
function layoutObserved(value:unknown,minimumWidth:number,minimumHeight:number):boolean{
  const layout=object(value);keys(layout,['coordinateSpace','target','safeArea','clips','visibleChain','viewport']);
  if(layout.coordinateSpace!=='CoreUISafeInsets'||typeof layout.visibleChain!=='boolean'||!Array.isArray(layout.clips)||layout.clips.length>8)invalid();
  const target=layoutRect(layout.target),safe=layoutRect(layout.safeArea),clips=layout.clips.map(layoutRect),viewport=object(layout.viewport);
  if(safe.left!==0||safe.top!==0||safe.right<=0||safe.bottom<=0)invalid();
  keys(viewport,['width','height','units']);if(viewport.units!=='RobloxUIOffset')invalid();
  for(const axis of [viewport.width,viewport.height])if(typeof axis!=='number'||!Number.isFinite(axis)||axis<=0||axis>16384)invalid();
  return layout.visibleChain&&target.right-target.left>=minimumWidth&&target.bottom-target.top>=minimumHeight&&
    [safe,...clips].every(rect=>target.left>=rect.left&&target.top>=rect.top&&target.right<=rect.right&&target.bottom<=rect.bottom);
}
function displayCopy(value: unknown): Readonly<Row> {
  let nodes = 0;
  const copy = (value: unknown, depth: number, scalar=false): DisplayValue => {
    if (++nodes > 2048 || depth > 12) invalid();
    if(scalar)return attributeScalar(value);
    if (typeof value === 'string') return text(value, 4096);
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') {if(!Number.isFinite(value)||Math.abs(value)>Number.MAX_SAFE_INTEGER)invalid();return value;}
    if (Array.isArray(value)) {
      if (value.length > 64) invalid();
      return Object.freeze(value.map(item => copy(item, depth + 1))) as unknown as DisplayValue[];
    }
    const source = object(value), result: { [key: string]: DisplayValue } = {};
    const entries = Object.entries(source);
    if (!entries.length || entries.length > 32) invalid();
    for (const [key, child] of entries) {
      if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key) || ['__proto__', 'constructor', 'prototype'].includes(key)) invalid();
      // Attested private-target metadata is text, never an object coerced into a name.
      if (key === 'trustedPrivateTarget') {
        if (typeof child === 'string') text(child);
        else for (const field of Object.values(object(child))) text(field);
      }
      result[key] = copy(child, depth + 1,source.kind==='assert-player-attribute'&&key==='equals');
    }
    return Object.freeze(result);
  };
  return object(copy(value, 0));
}
/** Human-readable projection of the exact immutable display. It grants no
 * authority and never replaces the digest or the complete audit underneath. */
function scenarioPlanView(plan:Row):ScenarioPlanView {
  const targets=new Map<string,{label:string;className:string}>();
  const identity=(value:unknown)=>{const id=text(value,64);if(!/^[A-Za-z0-9_-]{1,64}(?![\s\S])/.test(id))invalid();return id;};
  for(const value of plan.targets as unknown[]){
    const target=object(value);keys(target,['id','root','segments','className']);const id=identity(target.id);
    if(targets.has(id)||target.root!=='LocalPlayer.PlayerGui'||!Array.isArray(target.segments)||!target.segments.length||target.segments.length>8||
      !['TextButton','ImageButton','TextLabel','Frame'].includes(target.className as string))invalid();
    targets.set(id,{label:['PlayerGui',...target.segments.map(segment=>text(segment,100))].join(' → '),className:target.className as string});
  }
  const ids=new Set<string>();let budget=0;
  const steps=(plan.steps as unknown[]).map(value=>{
    const step=object(value),id=identity(step.id);if(ids.has(id))invalid();ids.add(id);
    if(step.kind==='hold-key'){
      keys(step,['id','kind','key','holdMs']);if(!['W','A','S','D','E','F','Space'].includes(step.key as string))invalid();
      const holdMs=integer(step.holdMs,25,1000);budget+=holdMs;return 'Hold '+step.key+' for '+holdMs+' ms.';
    }
    if(step.kind==='assert-displacement'){
      keys(step,['id','kind','minimumStuds']);const distance=step.minimumStuds;
      if(typeof distance!=='number'||!Number.isFinite(distance)||distance<0.1||distance>32)invalid();
      return 'Assert horizontal movement of at least '+distance+(distance===1?' stud.':' studs.');
    }
    if(step.kind==='assert-player-attribute'){
      keys(step,['id','kind','attribute','equals','withinMs'],['requireTransition']);
      const attribute=text(step.attribute,100),value=attributeScalar(step.equals),withinMs=integer(step.withinMs,25,1000);budget+=withinMs;
      if(/[\u0000-\u001f]/u.test(attribute)||step.requireTransition!==undefined&&typeof step.requireTransition!=='boolean')invalid();
      return 'Observe LocalPlayer attribute '+JSON.stringify(attribute)+' equals '+JSON.stringify(value)+' within '+withinMs+' ms.'+
        (step.requireTransition!==false?' Require a transition from its initial value.':' An already satisfied result is allowed.')+' Client observation; server authority is unverified.';
    }
    const target=targets.get(identity(step.targetId));if(!target)invalid();
    if(step.kind==='click-gui'){
      keys(step,['id','kind','targetId']);if(!['TextButton','ImageButton'].includes(target.className))invalid();budget+=50;
      return 'Click '+target.label+' ('+target.className+').';
    }
    if(step.kind==='assert-gui-layout'){
      keys(step,['id','kind','targetId','minimumWidth','minimumHeight','withinMs']);
      const width=integer(step.minimumWidth,1,4096),height=integer(step.minimumHeight,1,4096),withinMs=integer(step.withinMs,25,1000);budget+=withinMs;
      return 'Check '+target.label+' is at least '+width+' x '+height+' GUI pixels, with a visible ancestry chain and its full rectangle inside the Core UI safe area and clipping ancestors, within '+withinMs+' ms. Layout snapshot; occlusion and device input are unverified.';
    }
    if(step.kind!=='assert-gui'&&step.kind!=='assert-text')invalid();
    keys(step,step.kind==='assert-gui'?['id','kind','targetId','property','equals','withinMs']:['id','kind','targetId','equals','withinMs'],['requireTransition']);
    const withinMs=integer(step.withinMs,25,1000);budget+=withinMs;
    if(step.requireTransition!==undefined&&typeof step.requireTransition!=='boolean')invalid();
    const transition=step.requireTransition!==false?' Require a transition from its initial value.':' An already satisfied result is allowed.';
    if(step.kind==='assert-gui'){
      if(step.property!=='Visible'||typeof step.equals!=='boolean')invalid();
      return 'Assert '+target.label+' is '+(step.equals?'visible':'hidden')+' within '+withinMs+' ms.'+transition;
    }
    if(!['TextButton','TextLabel'].includes(target.className))invalid();
    return 'Assert '+target.label+' text equals '+JSON.stringify(text(step.equals,100))+' within '+withinMs+' ms.'+transition;
  });
  if(budget>Number(plan.runtimeBudgetMs))invalid();
  const capture=object(plan.capture);keys(capture,['required']);if(typeof capture.required!=='boolean')invalid();
  if(plan.temporaryEdits!==undefined&&(!Array.isArray(plan.temporaryEdits)||!plan.temporaryEdits.length||plan.temporaryEdits.length>4))invalid();
  const editIds=new Set<string>();
  const temporaryChanges=((plan.temporaryEdits??[])as unknown[]).map(value=>{
    const edit=object(value);keys(edit,['id','ref','expected','properties']);const id=identity(edit.id);if(editIds.has(id))invalid();editIds.add(id);
    const ref=object(edit.ref);keys(ref,['instanceId','sessionId','root','pathSegments','className']);text(ref.instanceId);text(ref.sessionId);
    if(!Array.isArray(ref.pathSegments)||ref.pathSegments.length>64)invalid();
    const location=[text(ref.root),...ref.pathSegments.map(segment=>text(segment))].join(' → '),expected=object(edit.expected),properties=object(edit.properties),names=Object.keys(properties);
    if(!names.length||names.length!==Object.keys(expected).length||names.some(name=>!Object.hasOwn(expected,name)))invalid();
    return {target:text(ref.className)+' in '+location,changes:names.map(name=>name+': '+JSON.stringify(expected[name])+' → '+JSON.stringify(properties[name])+'.')};
  });
  return{runtimeBudgetMs:Number(plan.runtimeBudgetMs),captureRequired:capture.required,steps,temporaryChanges};
}
function readJob(value: unknown): Job {
  const source = object(value), id = text(source.id, 128);
  if (!/^[A-Za-z0-9_-]+$/.test(id)) invalid();
  // Deliberately never displayed; only whether a managed chat (agent caller) asked is kept.
  const agent = /^agent-[a-f0-9]{64}$/.test(text(source.actor));
  return readPresentation(source,id,agent);
}
/** Actor-free display/review projection. Historical metadata never becomes a live job. */
function readPresentation(source:Row,id:string,agent:boolean,targetLimit=256):Job {
  const targetName = text(source.targetName,targetLimit), displayDigest = text(source.displayDigest, 64);
  if (!/^[a-f0-9]{64}$/.test(displayDigest) || source.nativeAcceptance !== false ||
      !['native', 'fixture'].includes(source.evidence as string) ||
      !['needs_approval', 'running', 'complete', 'cancelled'].includes(source.state as string)) invalid();
  const display = displayCopy(source.display), proposal = object(display.proposal), binding = object(proposal.binding);
  keys(display, ['proposal', 'cleanupGraceMs', 'requestTimeoutMs', 'proofMaxAgeMs', 'consentExpiresAt', 'guarantee', 'actions', 'raceDisclosure'], ['trustedPrivateTarget']);
  keys(proposal, ['binding', 'durationMs', 'observationIntervalMs', 'failOnRuntimeError'], ['trustedPrivateTarget','scenario','subjectDigest']);
  keys(binding, ['pairedSessionId', 'nativeStudioId', 'placeId'], ['clientLifetimeId', 'pluginArtifactHash', 'scopeRevision']);
  text(binding.pairedSessionId); text(binding.nativeStudioId);
  for (const key of ['clientLifetimeId', 'pluginArtifactHash', 'scopeRevision']) if (binding[key] !== undefined) text(binding[key]);
  if (binding.placeId !== 0 || typeof proposal.failOnRuntimeError !== 'boolean') invalid();
  const durationMs = integer(proposal.durationMs, 1, 86_400_000);
  integer(proposal.observationIntervalMs, 1, 86_400_000);
  for (const key of ['cleanupGraceMs', 'requestTimeoutMs', 'proofMaxAgeMs']) integer(display[key], 1, 86_400_000);
  const consentExpiresAt = integer(display.consentExpiresAt, 1);
  const actions=proposal.scenario===undefined?ACTIONS:SCENARIO_ACTIONS;
  if (display.guarantee !== 'observed-non-atomic' || !Array.isArray(display.actions) ||
      display.actions.length !== actions.length || display.actions.some((action, index) => action !== actions[index])) invalid();
  text(display.raceDisclosure, 4096);
  const review = object(source.review);
  if (review.requiresHumanReview !== undefined && typeof review.requiresHumanReview !== 'boolean') invalid();
  integer(review.observations);
  let scenario:Job['review']['scenario'];
  let scenarioPlan:ScenarioPlanView|undefined;
  if(proposal.scenario!==undefined){
    const plan=object(proposal.scenario);keys(plan,['version','runtimeBudgetMs','targets','steps','capture'],['temporaryEdits']);
    if(plan.version!==1||!Array.isArray(plan.targets)||plan.targets.length>4||!Array.isArray(plan.steps)||!plan.steps.length||plan.steps.length>8||
        !/^[a-f0-9]{64}$/.test(text(proposal.subjectDigest,64)))invalid();
    integer(plan.runtimeBudgetMs,100,3000);
    scenarioPlan=scenarioPlanView(plan);
    const report=object(review.scenario);keys(report,['scenarioDigest','subjectDigest','state','inputRelease','temporary','steps','capture','consoleCoverage']);
    if(report.subjectDigest!==proposal.subjectDigest||!/^[a-f0-9]{64}$/.test(text(report.scenarioDigest,64))||!['not_started','running','passed','failed','unsupported','unknown'].includes(report.state as string)||
      !['not_started','observed_released','unknown'].includes(report.inputRelease as string)||!['not_started','running','restored','unknown'].includes(report.temporary as string)||report.consoleCoverage!=='ambiguous'||
      !Array.isArray(report.steps)||report.steps.length>8)invalid();
    const steps=report.steps.map(value=>object(value));
    if(steps.length>plan.steps.length||report.state==='passed'&&steps.length!==plan.steps.length)invalid();
    for(let index=0;index<steps.length;index++){
      const row=steps[index]!,step=object(plan.steps[index]);keys(row,['id','kind','outcome','expected','observed'],['baseline','layout','attribute']);
      if(row.id!==step.id||row.kind!==step.kind||!['passed','failed','not_run'].includes(row.outcome as string))invalid();
      const expected=step.kind==='hold-key'?String(step.key)+':'+String(step.holdMs):step.kind==='click-gui'?step.targetId:step.kind==='assert-displacement'?step.minimumStuds:
        step.kind==='assert-gui-layout'?'core-safe:'+String(step.minimumWidth)+'x'+String(step.minimumHeight):step.equals;
      if(row.expected!==expected||report.state==='passed'&&row.outcome!=='passed')invalid();
      if(step.kind==='assert-player-attribute'){
        if(row.baseline!==undefined||(row.attribute!==undefined)!==(typeof row.observed==='boolean')||
          typeof row.observed!=='boolean'&&row.observed!==null&&row.observed!=='not-observed'||
          row.outcome==='not_run'&&typeof row.observed==='boolean'||row.outcome==='passed'&&row.observed!==true||
          row.attribute!==undefined&&row.observed!==attributeObserved(row.attribute,step.attribute,step.equals,step.requireTransition!==false)||
          review.code==='ASSERTION_FAILED'&&row.outcome==='failed'&&(row.observed!==false||row.attribute===undefined))invalid();
      }else if(row.attribute!==undefined)invalid();
      if(step.kind==='assert-gui-layout'){
        if((row.layout!==undefined)!==(typeof row.observed==='boolean')||
          typeof row.observed!=='boolean'&&row.observed!==null&&row.observed!=='not-observed'||
          row.outcome==='not_run'&&typeof row.observed==='boolean'||row.outcome==='passed'&&row.observed!==true||
          row.layout!==undefined&&row.observed!==layoutObserved(row.layout,Number(step.minimumWidth),Number(step.minimumHeight))||
          review.code==='ASSERTION_FAILED'&&row.outcome==='failed'&&(row.observed!==false||row.layout===undefined))invalid();
      }else if(row.layout!==undefined)invalid();
      if(row.baseline!==undefined&&(step.kind==='assert-gui'?typeof row.baseline!=='boolean':step.kind==='assert-text'?typeof row.baseline!=='string':true))invalid();
      if(row.outcome==='passed'&&(step.kind==='assert-displacement'&&(typeof row.observed!=='number'||!Number.isFinite(row.observed)||row.observed<Number(step.minimumStuds))||
        (step.kind==='assert-gui'||step.kind==='assert-text')&&(row.observed!==step.equals||step.requireTransition!==false&&(row.baseline===undefined||row.baseline===step.equals))||
        (step.kind==='hold-key'||step.kind==='click-gui')&&row.observed!=='observed-released'))invalid();
    }
    if(review.code==='ASSERTION_FAILED'&&!steps.some(step=>step.outcome==='failed'))invalid();
    if(report.state==='passed'&&report.inputRelease!==(plan.steps.some(value=>['hold-key','click-gui'].includes(object(value).kind as string))?'observed_released':'not_started')||
      review.cleanup==='complete'&&report.inputRelease==='unknown'||review.outcome==='succeeded'&&(report.state!=='passed'||object(plan.capture).required!==false))invalid();
    let capture:NonNullable<Job['review']['scenario']>['capture']=null;
    if(report.capture!==null){const image=object(report.capture);keys(image,['id','sha256','bytes','mimeType','width','height','context','nativeAcceptance']);if(image.mimeType!=='image/png'||image.context!=='unattested'||image.nativeAcceptance!==false||!/^[A-Za-z0-9_-]{1,64}$/.test(text(image.id,64))||!/^[a-f0-9]{64}$/.test(text(image.sha256,64)))invalid();integer(image.width,1,4096);integer(image.height,1,4096);capture={id:image.id as string,sha256:image.sha256 as string,bytes:integer(image.bytes,1,2*1024*1024)};}
    scenario={state:report.state as string,inputRelease:report.inputRelease as string,temporary:report.temporary as string,steps,capture};
  }else if(review.scenario!==undefined||proposal.subjectDigest!==undefined)invalid();
  return {
    id, targetName, state: source.state as Job['state'], displayDigest, display,
    scope: JSON.stringify(display), durationMs, consentExpiresAt, evidence: source.evidence as Job['evidence'], agent,
    ...(scenarioPlan?{scenarioPlan}:{}),
    review: {
      phase: text(review.phase, 64), outcome: review.outcome === null ? null : text(review.outcome, 64),
      code: review.code === null ? null : text(review.code, 64), cleanup: text(review.cleanup, 64),
      requiresHumanReview: review.requiresHumanReview === true,
      ...(scenario?{scenario}:{}),
    },
  };
}
function readJobs(value: unknown): Job[] {
  const jobs = object(value).jobs;
  if (!Array.isArray(jobs) || jobs.length > 128) invalid();
  const result = jobs.map(readJob);
  if (new Set(result.map(job => job.id)).size !== result.length) invalid();
  return result;
}

/** Count bytes while reading, before decoding or parsing even an error body. */
async function readResponse(response: Response, signal: AbortSignal, maximum=RESPONSE_BYTES): Promise<unknown> {
  const cancel = async () => { try { await response.body?.cancel(); } catch { /* Already closed. */ } };
  const length = response.headers.get('content-length');
  if (response.redirected || (length !== null && (!/^\d+$/.test(length) || Number(length) > maximum)) ||
      !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '') || !response.body) {
    await cancel(); invalid();
  }
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  let size = 0;
  try {
    if (signal.aborted) invalid();
    while (true) {
      const part = await reader.read();
      if (signal.aborted) invalid();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > maximum) { await reader.cancel(); invalid(); }
      chunks.push(part.value);
    }
  } finally { signal.removeEventListener('abort', abort); reader.releaseLock(); }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  if (response.status !== 200) {
    let code: unknown = null;
    try { code = (JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)) as Row)?.error; } catch { /* Not a coded refusal. */ }
    if (typeof code === 'string' && /^[A-Z_]{1,64}$/.test(code)) throw new PlaytestRefusal(code);
    invalid();
  }
  const raw=new TextDecoder('utf-8', { fatal: true }).decode(body);
  return maximum===RESPONSE_BYTES?JSON.parse(raw) as unknown:historyJson(raw);
}
function active(job: Job): boolean { return job.state === 'needs_approval' || job.state === 'running'; }
function sameScope(left: Job, right: Job): boolean {
  return left.id === right.id && left.displayDigest === right.displayDigest && left.scope === right.scope &&
    left.targetName === right.targetName && left.evidence === right.evidence;
}
const HISTORY_PAGE_BYTES=32*1024,HISTORY_REPORT_BYTES=272*1024;
function boundedHistory(value:unknown):void {
  const pending:[unknown,number][]=[[value,0]];let count=0;
  while(pending.length){const [item,depth]=pending.pop()!;if(++count>32768||depth>32)invalid();
    if(typeof item==='string'){if(item.length>16384)invalid();continue;}
    if(item===null||typeof item==='boolean'||typeof item==='number'&&Number.isFinite(item))continue;
    if(!item||typeof item!=='object')invalid();const values=Object.values(item);
    if(values.length>(Array.isArray(item)?256:128))invalid();for(const child of values)pending.push([child,depth+1]);}
}
function historyJson(raw:string):unknown {
  const parsed:unknown=JSON.parse(raw);boundedHistory(parsed);let cursor=0,nodes=0;
  const space=()=>{while(/[\x20\t\r\n]/.test(raw[cursor]??'!'))cursor++;};
  const string=():string=>{const start=cursor++;while(cursor<raw.length){const c=raw[cursor++];if(c==='\\'){cursor++;continue;}if(c==='"')return JSON.parse(raw.slice(start,cursor)) as string;}return invalid();};
  const walk=(depth:number):void=>{if(++nodes>32768||depth>32)invalid();space();const c=raw[cursor];
    if(c==='"'){string();return;}if(c==='{'){cursor++;space();const names=new Set<string>();if(raw[cursor]==='}'){cursor++;return;}
      for(;;){space();if(raw[cursor]!=='"')invalid();const key=string();if(names.has(key))invalid();names.add(key);space();if(raw[cursor++]!==':')invalid();walk(depth+1);space();const end=raw[cursor++];if(end==='}')return;if(end!==',')invalid();}}
    if(c==='['){cursor++;space();if(raw[cursor]===']'){cursor++;return;}for(;;){walk(depth+1);space();const end=raw[cursor++];if(end===']')return;if(end!==',')invalid();}}
    while(cursor<raw.length&&!/[\s,}\]]/.test(raw[cursor]!))cursor++;
  };walk(0);space();if(cursor!==raw.length)invalid();return parsed;
}
const CODES=['OK','INVALID_REQUEST','BUSY','HUMAN_AUTH_REQUIRED','CONSENT_EXPIRED','BINDING_CHANGED','STALE_PROOF','PLACE_DENIED','MODE_MISMATCH','NOT_OWNED_PLAY','UNSUPPORTED_TOOL','BAD_NATIVE_RESPONSE','TIMEOUT','CANCELLED','DURATION_EXPIRED','DISCONNECTED','SHUTDOWN','EFFECT_UNKNOWN','RUNTIME_ERROR','ASSERTION_FAILED','JOURNAL_FAILED','FENCED'] as const;
const OUTCOMES=['succeeded','failed','cancelled','timed_out','rejected'] as const,CLEANUPS=['not_started','running','complete','unknown'] as const;
function choice<T extends string>(value:unknown,values:readonly T[]):T {if(typeof value!=='string'||!values.includes(value as T))invalid();return value as T;}
function hash(value:unknown):string {const result=text(value,64);if(!/^[a-f0-9]{64}$/.test(result))invalid();return result;}
function uuid(value:unknown):string {const result=text(value,36);if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(result))invalid();return result;}
function timestamp(value:unknown):string {const result=text(value,64);if(!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(result)||!Number.isFinite(Date.parse(result)))invalid();return result;}
function archiveStatus(value:unknown):StudioTestReportArchiveStatus {
  const row=object(value);keys(row,['state','code']);
  if(row.state==='ready'&&row.code===null)return{state:'ready',code:null};
  return{state:choice(row.state,['degraded','unavailable']),code:choice(row.code,['ARCHIVE_UNAVAILABLE','ARCHIVE_WRITE','ARCHIVE_CORRUPT','ARCHIVE_LIMIT','ARCHIVE_INPUT','ARCHIVE_CONFLICT'])};
}
function reportSummary(value:unknown):StudioTestReportSummary {
  const row=object(value);keys(row,['jobId','taskId','createdAt','observedAt','snapshot','targetName','observedState','outcome','code','cleanup','evidence','nativeAcceptance','historicalDigest']);
  const createdAt=timestamp(row.createdAt),observedAt=timestamp(row.observedAt);if(Date.parse(observedAt)<Date.parse(createdAt)||row.nativeAcceptance!==false)invalid();
  return{jobId:uuid(row.jobId),taskId:row.taskId===null?null:uuid(row.taskId),createdAt,observedAt,snapshot:choice(row.snapshot,['admission','terminal']),targetName:text(row.targetName,512),
    observedState:choice(row.observedState,['needs_approval','running','complete','cancelled']),outcome:row.outcome===null?null:choice(row.outcome,OUTCOMES),code:choice(row.code,CODES),cleanup:choice(row.cleanup,CLEANUPS),
    evidence:choice(row.evidence,['fixture','native']),nativeAcceptance:false,historicalDigest:hash(row.historicalDigest)};
}
function reportPage(value:unknown,projectId:string):{archive:StudioTestReportArchiveStatus;reports:StudioTestReportSummary[];nextCursor:string|null;omittedReports:number} {
  boundedHistory(value);
  const row=object(value);keys(row,['schemaVersion','projectId','archive','reports','nextCursor','omittedReports']);
  if(row.schemaVersion!==1||row.projectId!==projectId||!Array.isArray(row.reports)||row.reports.length>8)invalid();
  const reports=row.reports.map(reportSummary);if(new Set(reports.map(r=>r.jobId)).size!==reports.length)invalid();
  let nextCursor:string|null=null;
  if(row.nextCursor!==null){nextCursor=text(row.nextCursor,100);const match=/^1\.([a-f0-9]{64})\.([1-9][0-9]{0,15})$/.exec(nextCursor);
    if(!match||match[1]!==projectId||!Number.isSafeInteger(Number(match[2])))invalid();}
  return{archive:archiveStatus(row.archive),reports,nextCursor,omittedReports:integer(row.omittedReports)};
}
function canonical(value:unknown):string {
  const copy=(v:unknown):unknown=>Array.isArray(v)?v.map(copy):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([key,child])=>[key,copy(child)])):v;
  return JSON.stringify(copy(value));
}
async function digest(value:unknown):Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(canonical(value))))].map(byte=>byte.toString(16).padStart(2,'0')).join('');
}
function historicalReview(value:unknown,display:Row):Row {
  const review=object(value);keys(review,['runId','evidence','nativeAcceptance','binding','scopeDigest','phase','outcome','code','cleanup','startedAt','deadline','cleanupDeadline','watchdog','observations','logs','logsTruncated','requiresHumanReview','canStartAnotherOperation'],['scenario']);
  if(review.runId!==null)text(review.runId,128);choice(review.evidence,['fixture','native']);if(review.nativeAcceptance!==false)invalid();
  if(review.binding!==null&&canonical(review.binding)!==canonical(object(display.proposal).binding))invalid();if(review.scopeDigest!==null)hash(review.scopeDigest);
  choice(review.phase,['idle','admitting','starting','observing','waiting','stopping','done']);if(review.outcome!==null)choice(review.outcome,OUTCOMES);choice(review.code,CODES);choice(review.cleanup,CLEANUPS);
  for(const field of ['startedAt','deadline','cleanupDeadline'])if(review[field]!==null)integer(review[field]);
  for(const field of ['logsTruncated','requiresHumanReview','canStartAnotherOperation'])if(typeof review[field]!=='boolean')invalid();
  const proposal=object(display.proposal),duration=integer(proposal.durationMs,100,60_000),interval=integer(proposal.observationIntervalMs,25,2000),observationLimit=Math.ceil(duration/interval);
  if(interval>duration||observationLimit>128)invalid();integer(review.observations,0,observationLimit);if(!Array.isArray(review.logs)||review.logs.length>128)invalid();
  for(const value of review.logs){const log=object(value);keys(log,['idDigest','digest','level','bytes']);hash(log.idDigest);hash(log.digest);choice(log.level,['info','warning','error']);integer(log.bytes,0,8192);}
  const watchdog=object(review.watchdog);keys(watchdog,['armed','fired','reason']);if(typeof watchdog.armed!=='boolean'||typeof watchdog.fired!=='boolean')invalid();if(watchdog.reason!==null)choice(watchdog.reason,CODES);
  if(review.canStartAnotherOperation&&(review.phase!=='done'||review.requiresHumanReview||review.cleanup!=='complete')||review.outcome==='succeeded'&&review.code!=='OK')invalid();return review;
}
interface HistoricalView { summary:StudioTestReportSummary;job:Job;record:Row;archive:StudioTestReportArchiveStatus }
async function historicalReport(value:unknown,projectId:string,selected:StudioTestReportSummary,check:()=>boolean):Promise<HistoricalView> {
  boundedHistory(value);
  const envelope=object(value);keys(envelope,['schemaVersion','projectId','archive','report','receiptScope','currentSource','readOnly']);
  if(envelope.schemaVersion!==1||envelope.projectId!==projectId||envelope.receiptScope!=='historical-playtest'||envelope.currentSource!=='unobserved'||envelope.readOnly!==true)invalid();
  const record=object(envelope.report);keys(record,['schemaVersion','kind','projectId','jobId','taskId','createdAt','observedAt','snapshot','targetName','observedState','display','displayDigest','review','evidence','nativeAcceptance','historicalDigest']);
  if(record.schemaVersion!==1||record.kind!=='studio-playtest-report'||record.projectId!==projectId||new TextEncoder().encode(JSON.stringify(record)).length>256*1024)invalid();
  const review=historicalReview(record.review,object(record.display));
  const summary=reportSummary({jobId:record.jobId,taskId:record.taskId,createdAt:record.createdAt,observedAt:record.observedAt,snapshot:record.snapshot,targetName:record.targetName,
    observedState:record.observedState,outcome:review.outcome,code:review.code,cleanup:review.cleanup,evidence:record.evidence,nativeAcceptance:record.nativeAcceptance,historicalDigest:record.historicalDigest});
  if(canonical(summary)!==canonical(selected)||review.evidence!==record.evidence)invalid();
  const display=object(record.display);keys(display,['proposal','cleanupGraceMs','requestTimeoutMs','proofMaxAgeMs','consentExpiresAt','guarantee','actions','raceDisclosure']);
  const proposal=object(display.proposal);keys(proposal,['binding','durationMs','observationIntervalMs','failOnRuntimeError'],['scenario','subjectDigest']);
  const binding=object(proposal.binding);keys(binding,['nativeStudioId','pairedSessionId','clientLifetimeId','pluginArtifactHash','scopeRevision','placeId']);
  for(const key of ['nativeStudioId','pairedSessionId','clientLifetimeId'])if(!/^[A-Za-z0-9_-]{1,128}$/.test(text(binding[key],128)))invalid();
  hash(binding.pluginArtifactHash);hash(binding.scopeRevision);integer(proposal.durationMs,100,60_000);integer(proposal.observationIntervalMs,25,2000);
  for(const key of ['cleanupGraceMs','requestTimeoutMs','proofMaxAgeMs'])integer(display[key],1,15000);
  if(display.raceDisclosure!=='Observed checks cannot atomically fence the native call.')invalid();
  const job=readPresentation({targetName:record.targetName,state:record.observedState,displayDigest:record.displayDigest,display:record.display,review,evidence:record.evidence,nativeAcceptance:false},summary.jobId,false,512);
  if(review.runId===null){if(['binding','scopeDigest','startedAt','deadline','cleanupDeadline'].some(key=>review[key]!==null))invalid();}
  else if(review.binding===null||review.scopeDigest!==record.displayDigest||review.startedAt===null||review.deadline===null||review.cleanupDeadline===null||
    review.deadline!==Number(review.startedAt)+Number(proposal.durationMs)||review.cleanupDeadline!==Number(review.deadline)+Number(display.cleanupGraceMs))invalid();
  const displayDigest=hash(record.displayDigest);if(await digest(display)!==displayDigest||!check())invalid();
  if(review.scopeDigest!==null&&review.scopeDigest!==displayDigest)invalid();
  if(proposal.scenario!==undefined){const scenario=object(review.scenario);if(await digest(proposal.scenario)!==scenario.scenarioDigest||!check()||scenario.capture!==null&&object(scenario.capture).id!==review.runId)invalid();}
  if(summary.snapshot==='admission'&&(summary.observedState!=='needs_approval'||review.runId!==null||review.phase!=='idle'||review.outcome!==null||review.cleanup!=='not_started'||review.observations!==0))invalid();
  const {historicalDigest,...content}=record;if(await digest(content)!==historicalDigest||!check())invalid();
  return{summary,job,record,archive:archiveStatus(envelope.archive)};
}
function status(job: Job): { label: string; danger: boolean } {
  if (job.review.cleanup === 'unknown' || job.review.requiresHumanReview) return { label: 'Needs review', danger: true };
  if (job.state === 'needs_approval') return { label: '', danger: false };
  if (job.state === 'running') return { label: 'Testing…', danger: false };
  const clean = job.review.cleanup === 'complete' || (job.state === 'cancelled' && job.review.cleanup === 'not_started');
  if (!clean || (job.state === 'complete' && (job.review.phase !== 'done' ||
      !['succeeded', 'failed'].includes(job.review.outcome ?? '') || (job.review.outcome === 'succeeded' && job.review.code !== 'OK')))) {
    return { label: 'Needs review', danger: true };
  }
  return { label: job.state === 'cancelled' ? 'Test cancelled' : 'Test finished', danger: job.review.outcome === 'failed' };
}

/** Conversation-sized human consent UI. Mounting, styles and routes belong to the parent. */
export function startPlaytestPanel(options: PlaytestPanelOptions): PlaytestPanelController {
  const { root } = options, doc = root.ownerDocument, view = doc.defaultView;
  const transport = options.transport ?? globalThis.fetch;
  let stopped = false, pageHidden = false, epoch = 0, sessionToken: string | null = null;
  let sessionReportContext:string|null=null,reportProject:string|null=null;
  let timer: ReturnType<typeof setTimeout> | undefined, nextPoll = 0, stale = false;
  let jobs: Job[] = [];
  let request: { controller: AbortController; epoch: number; promise: Promise<void> } | null = null;
  // Negative deduplication only: an ambiguous command is never sent again for this scope.
  const attempted = new Set<string>();
  // Automatic approval: whether the Playtest switch was on when each job was first seen, and which jobs it approved.
  const firstSeenOn = new Map<string, boolean>(), autoApproved = new Set<string>();
  const autoOn = (): boolean => { try { return options.autoApprove?.() === true; } catch { return false; } };
  interface JobView { job: Job; signature: string; element: HTMLElement; heading: HTMLElement; details: HTMLDetailsElement; controls: HTMLButtonElement[]; remove(): void }
  const rendered = new Map<string, JobView>();
  const node = <K extends keyof HTMLElementTagNameMap>(tag: K, content?: string, className?: string): HTMLElementTagNameMap[K] => {
    const element = doc.createElement(tag);
    if (content !== undefined) element.textContent = content;
    if (className) element.className = className;
    return element;
  };
  const notice = node('p', '', 'playtest-notice');
  notice.setAttribute('role', 'status'); notice.setAttribute('aria-live', 'polite');
  const refreshButton = node('button', 'Refresh status', 'playtest-refresh'); refreshButton.type = 'button';
  // Shown only while the daemon reports FENCED: two trusted clicks (repair, then confirm Studio is stopped).
  const repairButton = node('button', PLAYTEST_REPAIR_COPY.button, 'playtest-repair'); repairButton.type = 'button'; repairButton.hidden = true;
  repairButton.setAttribute('data-playtest-action', 'repair');
  let repairArmed = false, fenced = false;
  const feedback = node('div', undefined, 'playtest-feedback'); feedback.append(notice, repairButton, refreshButton); feedback.hidden = true;
  const historySection=node('section',undefined,'playtest-history'),historyNotice=node('p','Saved reports are read-only. Current source is unobserved.','playtest-notice');
  historySection.setAttribute('aria-label','Saved playtest reports');historyNotice.setAttribute('role','status');
  const historyLoad=node('button','Load saved reports','playtest-refresh'),historyNext=node('button','Next reports','playtest-refresh');
  historyLoad.type=historyNext.type='button';historyNext.hidden=true;
  const historyList=node('div'),historyResult=node('div');historySection.append(node('h3','Saved playtest reports','playtest-title'),historyNotice,historyLoad,historyNext,historyList,historyResult);
  let historyCursor:string|null=null,historyRow:JobView|null=null;
  let removeHistoryListeners:(()=>void)[]=[];
  const historyButtons:HTMLButtonElement[]=[];
  root.hidden = true; root.replaceChildren();
  root.setAttribute('role', 'region'); root.setAttribute('aria-label', 'Playtests'); root.setAttribute('aria-busy', 'false');

  function clearRows(): void {
    for (const row of rendered.values()) row.remove();
    rendered.clear(); jobs = []; root.replaceChildren(); root.hidden = true; showFence(false);
    root.setAttribute('aria-busy', 'false'); notice.textContent = ''; feedback.hidden = true; stale = false;
    historyRow?.remove();historyRow=null;removeHistoryListeners.forEach(remove=>remove());removeHistoryListeners=[];historyButtons.length=0;
    historyList.replaceChildren();historyResult.replaceChildren();historyCursor=null;historyNext.hidden=true;historyLoad.textContent='Load saved reports';
    historyNotice.textContent='Saved reports are read-only. Current source is unobserved.';
  }
  function invalidate(): void {
    epoch++; request?.controller.abort(); request = null; sessionToken = null;sessionReportContext=null;reportProject=null; clearRows();
  }
  function context(): string | null {
    if (stopped || pageHidden || doc.visibilityState !== 'visible') return null;
    try {
      if (!options.isSignedIn()) return null;
      const token = options.token();
      return typeof token === 'string' && token.length > 0 && token.length <= 4096 && !/[\s\x00-\x1f\x7f]/.test(token) ? token : null;
    } catch { return null; }
  }
  function syncContext(): string | null {
    let token = context(),identity:ReturnType<NonNullable<PlaytestPanelOptions['reportContext']>>=null;
    if(options.reports===true&&token){try{identity=options.reportContext?.()??null;
      if(!identity||!/^[a-f0-9]{64}$/.test(identity.projectId)||!Number.isSafeInteger(identity.projectEpoch)||identity.projectEpoch<0||!Number.isSafeInteger(identity.authEpoch)||identity.authEpoch<0)token=null;
    }catch{token=null;identity=null;}}
    const signature=token&&identity?JSON.stringify([identity.projectId,identity.projectEpoch,identity.authEpoch]):null;
    if (token !== sessionToken||signature!==sessionReportContext) { invalidate(); sessionToken = token;sessionReportContext=signature;reportProject=token&&identity?identity.projectId:null; nextPoll = 0;if(token&&options.reports===true)render(); }
    return token;
  }
  function current(operation: NonNullable<typeof request>, token: string): boolean {
    return syncContext() === token && request === operation && epoch === operation.epoch && !operation.controller.signal.aborted;
  }
  const attemptKey = (job: Job, action: string) => action + ':' + job.id + ':' + job.displayDigest;
  function busy(): void {
    root.setAttribute('aria-busy', String(request !== null)); refreshButton.disabled = request !== null; repairButton.disabled = request !== null || !fenced;
    historyLoad.disabled=historyNext.disabled=request!==null;for(const button of historyButtons)button.disabled=request!==null;
    for (const row of rendered.values()) for (const button of row.controls) {
      const action = button.getAttribute('data-playtest-action')!;
      button.disabled = request !== null || stale || attempted.has(attemptKey(row.job, action)) ||
        (action === 'approve' && (row.job.consentExpiresAt <= Date.now() || row.job.review.requiresHumanReview || row.job.review.cleanup === 'unknown'));
    }
  }
  function message(content: string): void { notice.textContent = content; feedback.hidden = !content; }
  function showFence(on: boolean): void {
    fenced = on; repairArmed = false; repairButton.hidden = !on; repairButton.textContent = PLAYTEST_REPAIR_COPY.button;
    if (on) { message(PLAYTEST_REPAIR_COPY.fenced); if (!root.contains(feedback)) root.replaceChildren(feedback,...(reportProject?[historySection]:[])); root.hidden = false; }
  }
  function detailsFor(job: Job): HTMLDetailsElement {
    const details = node('details', undefined, 'playtest-details');
    const summary = node('summary', 'Permission details'); summary.setAttribute('data-playtest-action', 'details');
    details.append(summary, node('p', job.review.scenario?'Allow this exact gameplay scenario to run its listed steps, inspect its assertions, capture the viewport when requested, stop its owned play and restore the listed temporary changes.':'Allow this test to start play, observe state and console, then stop only the play it owns.'));
    const fields = node('dl');
    function field(key: string, value: string): void { fields.append(node('dt', key), node('dd', value)); }
    function walk(value: unknown, path: string): void {
      if (Array.isArray(value)) value.forEach((child, index) => walk(child, path + '[' + index + ']'));
      else if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) walk(child, path ? path + '.' + key : key);
      else field(path, typeof value === 'string' ? value : String(value));
    }
    walk(job.display, 'display'); field('displayDigest', job.displayDigest);
    details.append(fields); return details;
  }
  function makeRow(job: Job, signature: string, historical?:HistoricalView): JobView {
    const element = node('article', undefined, 'playtest-row'), heading = node('h3', 'Playtest · ' + job.targetName, 'playtest-title');
    heading.tabIndex = -1;
    element.append(heading, node('p', (job.durationMs / 1000) + ' s · Local, unpublished place', 'playtest-subtitle'));
    const state = historical&&historical.summary.snapshot==='admission'?{label:'Last observed · Outcome unavailable',danger:false}:status(job);
    if(historical){heading.textContent='Saved playtest · '+job.targetName;element.append(node('p','Historical report · Read-only · Last observed '+historical.summary.observedAt+' · Current source unobserved.'));}
    if (state.label) {
      const label = node('p', state.label, state.danger ? 'playtest-status danger' : 'playtest-status');
      label.setAttribute('role', 'status'); label.setAttribute('aria-live', 'polite'); element.append(label);
    }
    if(!historical&&autoApproved.has(job.id)&&job.state!=='needs_approval')element.append(node('p','Approved automatically · Playtest is on','playtest-auto'));
    else if(!historical&&job.state==='needs_approval'&&job.agent&&firstSeenOn.get(job.id)===true&&autoOn())element.append(node('p','Playtest is on · approving automatically','playtest-auto'));
    if(job.review.outcome!==null)element.append(node('p','Result: '+job.review.outcome+' · Code: '+(job.review.code??'unavailable')+' · Cleanup: '+job.review.cleanup,'playtest-result'));
    if (job.evidence === 'fixture' || !active(job)) element.append(node('p',
      job.evidence === 'fixture' ? 'Fixture evidence · Native acceptance unverified' : 'Native evidence · Native acceptance unverified', 'playtest-evidence'));
    const controls: HTMLButtonElement[] = [], listeners: (() => void)[] = [];
    let captureUrl:string|null=null,captureAbort:AbortController|null=null;
    if(job.review.scenario){
      const report=job.review.scenario,plan=job.scenarioPlan!;
      if(job.state==='needs_approval'&&!historical){
        element.append(node('p','Scenario plan · '+plan.steps.length+' '+(plan.steps.length===1?'step':'steps')+' · '+plan.runtimeBudgetMs+' ms Client execution limit.'));
        const list=node('ol');for(const step of plan.steps)list.append(node('li',step));element.append(list);
        if(plan.temporaryChanges.length){
          element.append(node('p','Temporary changes · Restore exact prior values after owned Play stops.'));
          const edits=node('ul');for(const edit of plan.temporaryChanges)edits.append(node('li',edit.target+' · '+edit.changes.join(' ')));element.append(edits);
        }else element.append(node('p','Temporary changes: none.'));
      }else{
        element.append(node('p','Measured steps: '+report.state+' · Input release: '+report.inputRelease.replaceAll('_',' ')+' · Temporary changes: '+report.temporary.replaceAll('_',' ')));
      }
      if(plan.captureRequired)element.append(node('p',
        (!active(job)?'Required Client capture: still unverified. ':'Required Client capture: unverified. ')+
        (report.capture?'The retained image has unverified context.':'Current capture support does not attest Client context.')));
      else element.append(node('p','Viewport capture: not requested.'));
      const firstFailure=report.steps.find(step=>step.outcome==='failed');if(firstFailure)element.append(node('p','First failed step: '+String(firstFailure.id),'playtest-status danger'));
      if(report.steps.length){const list=node('ol');for(const step of report.steps){
        const expected=step.kind==='assert-gui-layout'?String(step.expected).replace(/^core-safe:(\d+)x(\d+)$/,'at least $1 x $2 GUI pixels'):
          step.kind==='assert-player-attribute'?JSON.stringify(step.expected):String(step.expected);
        const describe=(value:unknown)=>{const observation=object(value);return observation.present?JSON.stringify(observation.value):'absent';};
        const observed=step.attribute?describe(object(step.attribute).observed):String(step.observed);
        const item=node('li',String(step.id)+' · '+String(step.outcome)+' · Expected '+expected+' · Observed '+observed);
        if(step.attribute){
          const measurement=object(step.attribute);
          item.append(node('p','Client player attribute '+JSON.stringify(measurement.name)+': '+describe(measurement.observed)+'. Initial value: '+describe(measurement.baseline)+'. Server authority is unverified.'));
          const details=node('details');details.append(node('summary','Attribute evidence'),node('pre',JSON.stringify(measurement,null,2)));item.append(details);
        }
        if(step.layout){
          const layout=object(step.layout),target=layoutRect(layout.target),safe=layoutRect(layout.safeArea),viewport=object(layout.viewport);
          item.append(node('p','Layout snapshot: '+(target.right-target.left)+' x '+(target.bottom-target.top)+' GUI pixels at ('+target.left+', '+target.top+'). Core UI safe area: '+(safe.right-safe.left)+' x '+(safe.bottom-safe.top)+' GUI pixels. Clipping ancestors: '+
            (layout.clips as unknown[]).length+'. Target and parents visible: '+(layout.visibleChain?'yes':'no')+'. Overlap and device behavior unverified.'));
          const evidence=node('details',undefined,'playtest-layout-evidence');
          evidence.append(node('summary','Layout evidence'),node('p','Camera viewport: '+viewport.width+' x '+viewport.height+' Roblox UI offset units; separate from GUI pixels.'),node('pre',JSON.stringify(layout,null,2)));
          item.append(evidence);
        }
        list.append(item);
      }element.append(list);}
      if(report.capture){
        const image=report.capture,button=node('button','View capture · Context unverified');button.type='button';
        const click=(event:Event)=>{const originalToken=syncContext();if(event.isTrusted!==true||button.disabled||!root.contains(element)||!originalToken)return;button.disabled=true;const originalEpoch=epoch;captureAbort=new AbortController();const controller=captureAbort;const timeout=setTimeout(()=>controller.abort(),8000);
          const sameContext=()=>syncContext()===originalToken&&epoch===originalEpoch&&root.contains(element);
          const captured=()=>sameContext()&&!controller.signal.aborted;
          void(async()=>{try{const response=await transport((historical?'/v1/playtests/history/capture?id=':'/v1/playtests/capture?id=')+encodeURIComponent(job.id),{method:'GET',headers:{Authorization:'Bearer '+originalToken},signal:controller.signal,credentials:'same-origin',redirect:'error',cache:'no-store'});
            if(!captured()){await response.body?.cancel();invalid();}
            const length=response.headers.get('content-length');
            if(response.status!==200||response.redirected||response.headers.get('content-type')!=='image/png'||!response.body||length!==null&&(!/^\d+$/.test(length)||Number(length)>2*1024*1024)){try{await response.body?.cancel();}catch{/* Closed. */}invalid();}
            const reader=response.body.getReader(),chunks:Uint8Array[]=[];let total=0;const abort=()=>{void reader.cancel().catch(()=>{});};controller.signal.addEventListener('abort',abort,{once:true});
            try{for(;;){const item=await reader.read();if(!captured())invalid();if(item.done)break;total+=item.value.byteLength;if(total>2*1024*1024)invalid();chunks.push(item.value);}}finally{controller.signal.removeEventListener('abort',abort);await reader.cancel().catch(()=>{});reader.releaseLock();}
            const bytes=new Uint8Array(total);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
            const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(value=>value.toString(16).padStart(2,'0')).join('');
            if(total!==image.bytes||hash!==image.sha256||!captured())invalid();
            captureUrl=URL.createObjectURL(new Blob([bytes],{type:'image/png'}));const preview=node('img');preview.src=captureUrl;preview.alt='Gameplay scenario viewport capture';preview.style.maxWidth='100%';element.append(preview);
          }catch{if(sameContext())message(historical?'Capture unavailable. Open this saved report again to inspect its retained evidence.':'Capture unavailable. Refresh this test’s status to inspect its retained evidence.');}finally{clearTimeout(timeout);captureAbort=null;}})();};
        button.addEventListener('click',click);listeners.push(()=>button.removeEventListener('click',click));element.append(button);
      }
    }
    function button(label: string, action: 'approve' | 'cancel'): void {
      const button = node('button', label); button.type = 'button'; button.setAttribute('data-playtest-action', action);
      button.setAttribute('aria-label', label + ' · ' + job.targetName);
      const click = (event: Event) => {
        if (event.isTrusted !== true || button.disabled || !root.contains(button) || rendered.get(job.id)?.element !== element) return;
        event.preventDefault(); void mutate(job, action);
      };
      button.addEventListener('click', click); listeners.push(() => button.removeEventListener('click', click));
      controls.push(button); element.append(button);
    }
    if (!historical&&job.state === 'needs_approval') button('Run test', 'approve');
    if (!historical&&active(job)) button(job.state === 'running' ? 'Stop' : 'Cancel', 'cancel');
    const details = detailsFor(job);if(historical){details.children[0]!.textContent='Report details';details.children[1]!.textContent='Recorded permission display and actual observed review. Read-only; this grants no current test permission.';details.append(node('pre',JSON.stringify(historical.record,null,2)));} element.append(details);
    return { job, signature, element, heading, details, controls, remove() { captureAbort?.abort();if(captureUrl)URL.revokeObjectURL(captureUrl);listeners.forEach(remove => remove()); } };
  }
  function render(): void {
    const selected = [...jobs].reverse().filter(job => active(job) || rendered.has(job.id)).slice(0, VISIBLE_JOBS);
    const focused = doc.activeElement as HTMLElement | null;
    const focusedRow = [...rendered.values()].find(row => focused && row.element.contains(focused));
    const focusedAction = focused?.getAttribute('data-playtest-action');
    const historyVisible=options.reports===true&&reportProject!==null;
    let changed = root.children.length !== selected.length + 1+(historyVisible?1:0);
    const next = new Map<string, JobView>();
    for (const job of selected) {
      const signature = JSON.stringify([job.id, job.targetName, job.state, job.scope, job.displayDigest, job.evidence, status(job),job.review,autoApproved.has(job.id),autoOn()]);
      const previous = rendered.get(job.id);
      let row = previous;
      if (!row || row.signature !== signature) {
        row = makeRow(job, signature); row.details.open = previous?.details.open ?? false;
        previous?.remove(); changed = true;
      }
      row.job = job; next.set(job.id, row);
    }
    for (const [id, row] of rendered) if (!next.has(id)) { row.remove(); changed = true; }
    const order = [...next.keys()];
    if (order.some((id, index) => [...rendered.keys()][index] !== id)) changed = true;
    rendered.clear(); for (const [id, row] of next) rendered.set(id, row);
    if (changed) {
      root.replaceChildren(feedback, ...[...rendered.values()].map(row => row.element),...(historyVisible?[historySection]:[]));
      if (focusedRow && focused) {
        const replacement = rendered.get(focusedRow.job.id);
        if (root.contains(focused)) focused.focus();
        else if (replacement) {
          const target = replacement.controls.find(button => button.getAttribute('data-playtest-action') === focusedAction);
          (target ?? replacement.heading).focus();
        }
      }
    }
    root.hidden = selected.length === 0 && !fenced&&!historyVisible; busy();
  }

  function run(token: string, method: 'GET' | 'POST', path: string, body: Row | undefined,
    accept: (value: unknown,current:()=>boolean) => void|Promise<void>, failure: (error?: unknown) => void, after?: () => void,maximum=RESPONSE_BYTES): Promise<void> {
    const controller = new AbortController();
    const operation = { controller, epoch, promise: Promise.resolve() };
    request = operation; nextPoll = Date.now() + POLL_MS; busy();
    operation.promise = (async () => {
      let deadline: ReturnType<typeof setTimeout> | undefined;
      let removeAbort = () => {};
      try {
        const aborted = new Promise<never>((_resolve, reject) => {
          const abort = () => reject(new Error('Playtest request aborted'));
          controller.signal.addEventListener('abort', abort, { once: true });
          removeAbort = () => controller.signal.removeEventListener('abort', abort);
        });
        deadline = setTimeout(() => controller.abort(), TIMEOUT_MS);
        const headers: Record<string, string> = { Authorization: 'Bearer ' + token, Accept: 'application/json' };
        if (method === 'POST') headers['Content-Type'] = 'application/json';
        // A relative same-origin fetch lets the browser supply Origin. No asserted human identity.
        const response = await Promise.race([transport(path, {
          method, headers, signal: controller.signal, credentials: 'same-origin', cache: 'no-store', redirect: 'error',
          ...(body ? { body: JSON.stringify(body) } : {}),
        }).then(async response => {
          if (controller.signal.aborted) { try { await response.body?.cancel(); } catch { /* Closed. */ } invalid(); }
          return readResponse(response, controller.signal,maximum);
        }), aborted]);
        if (current(operation, token)) await accept(response,()=>current(operation,token));
      } catch (error) {
        // A deadline is reportable; an invalidated generation has no UI authority.
        if (syncContext() === token && request === operation && epoch === operation.epoch) failure(error);
      } finally {
        if (deadline !== undefined) clearTimeout(deadline); removeAbort();
        if (request === operation && epoch === operation.epoch) {
          request = null; busy(); after?.();
        }
      }
    })();
    return operation.promise;
  }
  function showHistorical(selected:StudioTestReportSummary):Promise<void> {
    const token=syncContext(),project=reportProject,generation=epoch;
    if(!token||!project||request||options.reports!==true)return Promise.resolve();
    return run(token,'GET','/v1/playtests/history/report?id='+encodeURIComponent(selected.jobId),undefined,async(value,readCurrent)=>{
      const valid=()=>readCurrent()&&syncContext()===token&&epoch===generation&&reportProject===project;
      const report=await historicalReport(value,project,selected,valid);if(!valid())return;
      historyRow?.remove();historyRow=makeRow(report.job,report.summary.historicalDigest,report);
      historyResult.replaceChildren(historyRow.element);historyRow.heading.focus();
    },()=>{historyNotice.textContent='Saved report unavailable. Load the latest reports to check again.';},undefined,HISTORY_REPORT_BYTES);
  }
  function loadHistory(cursor:string|null):Promise<void> {
    const token=syncContext(),project=reportProject;
    if(!token||!project||request||options.reports!==true)return Promise.resolve();
    return run(token,'GET','/v1/playtests/history'+(cursor?'?cursor='+encodeURIComponent(cursor):''),undefined,value=>{
      const page=reportPage(value,project);historyCursor=page.nextCursor;historyNext.hidden=historyCursor===null;historyLoad.textContent='Latest reports';
      historyRow?.remove();historyRow=null;historyResult.replaceChildren();removeHistoryListeners.forEach(remove=>remove());removeHistoryListeners=[];historyButtons.length=0;historyList.replaceChildren();
      historyNotice.textContent='Saved reports are read-only. Current source is unobserved. Archive '+page.archive.state+(page.archive.code?' · '+page.archive.code:'')+'.'+
        (page.omittedReports?' '+page.omittedReports+' earlier reports omitted by retention.':'')+(!page.reports.length?' No saved reports on this page.':'');
      for(const summary of page.reports){
        const row=node('article',undefined,'playtest-row'),open=node('button','Open report · '+summary.targetName,'playtest-refresh');open.type='button';
        row.append(open,node('p',summary.observedAt+' · '+(summary.snapshot==='admission'?'Last observed · Outcome unavailable':(summary.outcome??'Outcome unavailable')+' · '+summary.code+' · Cleanup '+summary.cleanup)));
        const click=(event:Event)=>{if(event.isTrusted===true&&!open.disabled&&root.contains(open))void showHistorical(summary);};
        open.addEventListener('click',click);removeHistoryListeners.push(()=>open.removeEventListener('click',click));historyButtons.push(open);historyList.append(row);
      }
    },()=>{historyNotice.textContent='Saved reports unavailable. Try loading the latest reports again.';},undefined,HISTORY_PAGE_BYTES);
  }
  const historyLoadClick=(event:Event)=>{if(event.isTrusted===true&&!historyLoad.disabled&&root.contains(historyLoad))void loadHistory(null);};
  const historyNextClick=(event:Event)=>{if(event.isTrusted===true&&!historyNext.disabled&&root.contains(historyNext)&&historyCursor)void loadHistory(historyCursor);};
  historyLoad.addEventListener('click',historyLoadClick);historyNext.addEventListener('click',historyNextClick);
  function refresh(): Promise<void> {
    const token = syncContext();
    if (!token) return Promise.resolve();
    if (request) return request.promise;
    return run(token, 'GET', '/v1/playtests', undefined, value => {
      jobs = readJobs(value); stale = false; if (fenced) { showFence(false); message(''); }
      for (const job of jobs) if (!firstSeenOn.has(job.id)) firstSeenOn.set(job.id, job.state === 'needs_approval' && autoOn());
      render();
    }, error => {
      if (error instanceof PlaytestRefusal && error.code === 'FENCED') { stale = false; showFence(true); busy(); return; }
      stale = true; message('Couldn’t refresh test status. Refresh status to check again.'); render();
    });
  }
  /** The person's repair: moves the earlier journal aside (kept, never deleted) and restarts playtests. */
  function repair(): Promise<void> {
    const token = syncContext();
    if (!token || request || !fenced) return Promise.resolve();
    return run(token, 'POST', '/v1/playtests/repair', { confirm: 'studio-in-edit-mode' }, value => {
      if (object(value).repaired !== true) invalid();
      showFence(false); message(PLAYTEST_REPAIR_COPY.done);
    }, error => {
      if (error instanceof PlaytestRefusal && error.code === 'NOT_FENCED') { showFence(false); message(''); return; }
      showFence(true); message(PLAYTEST_REPAIR_COPY.failed); busy();
    }, () => { void refresh(); });
  }
  const repairClick = (event: Event) => {
    if (event.isTrusted !== true || repairButton.disabled || !root.contains(repairButton) || !fenced) return;
    if (!repairArmed) { repairArmed = true; repairButton.textContent = PLAYTEST_REPAIR_COPY.confirm; return; }
    repairArmed = false; void repair();
  };
  repairButton.addEventListener('click', repairClick);
  /** The pending request the switch may approve: from the managed chat, first seen while on, with the same checks a click has. */
  function autoCandidate(): Job | null {
    if (!autoOn() || request || stale) return null;
    return jobs.find(job => job.state === 'needs_approval' && job.agent && firstSeenOn.get(job.id) === true &&
      job.consentExpiresAt > Date.now() && !job.review.requiresHumanReview && job.review.cleanup !== 'unknown' &&
      !attempted.has(attemptKey(job, 'approve'))) ?? null;
  }
  function autoApprove(): void {
    const job = autoCandidate();
    if (!job || !syncContext()) return;
    autoApproved.add(job.id); void mutate(job, 'approve');
  }
  function mutate(captured: Job, action: 'approve' | 'cancel'): Promise<void> {
    const token = syncContext(), latest = jobs.find(job => job.id === captured.id);
    if (!token || request || stale || !latest || !sameScope(captured, latest) || latest.state !== captured.state ||
        !active(latest) || (action === 'approve' && (latest.state !== 'needs_approval' || latest.consentExpiresAt <= Date.now() ||
          latest.review.requiresHumanReview || latest.review.cleanup === 'unknown')) ||
        attempted.has(attemptKey(captured, action))) return Promise.resolve();
    attempted.add(attemptKey(captured, action)); message('');
    return run(token, 'POST', '/v1/playtests/' + action,
      action === 'approve' ? { id: captured.id, displayDigest: captured.displayDigest } : { id: captured.id }, value => {
        const returned = readJob(object(value).job);
        if (!sameScope(returned, captured) || returned.state === 'needs_approval' ||
            (action === 'approve' && returned.state === 'cancelled') || (action === 'cancel' && returned.state === 'running')) invalid();
        jobs = jobs.map(job => job.id === returned.id ? returned : job); stale = false; render();
      }, () => { stale = true; message('Couldn’t confirm the request. Refresh status; this request won’t be sent again.'); busy(); },
      () => { void refresh(); });
  }
  const refreshClick = (event: Event) => { if (event.isTrusted === true && !refreshButton.disabled && root.contains(refreshButton)) void refresh(); };
  refreshButton.addEventListener('click', refreshClick);
  function schedule(): void {
    if (stopped || pageHidden || doc.visibilityState !== 'visible') return;
    timer = setTimeout(() => {
      timer = undefined;
      if (syncContext() && !request && Date.now() >= nextPoll) void refresh();
      else autoApprove();
      busy(); schedule();
    }, AUTH_CHECK_MS);
  }
  function visibility(): void {
    if (timer !== undefined) clearTimeout(timer); timer = undefined;
    syncContext();
    if (context()) void refresh();
    schedule();
  }
  const hide = () => { pageHidden = true; visibility(); };
  const show = () => { pageHidden = false; visibility(); };
  doc.addEventListener('visibilitychange', visibility);
  view?.addEventListener('pagehide', hide); view?.addEventListener('pageshow', show);
  void refresh(); schedule();
  return {
    refresh,
    stop() {
      if (stopped) return;
      stopped = true; if (timer !== undefined) clearTimeout(timer); timer = undefined;
      doc.removeEventListener('visibilitychange', visibility);
      view?.removeEventListener('pagehide', hide); view?.removeEventListener('pageshow', show);
      refreshButton.removeEventListener('click', refreshClick); repairButton.removeEventListener('click', repairClick);historyLoad.removeEventListener('click',historyLoadClick);historyNext.removeEventListener('click',historyNextClick); invalidate(); attempted.clear(); firstSeenOn.clear(); autoApproved.clear();
    },
  };
}
