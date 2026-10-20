/// <reference lib="dom" />
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { startPlaytestPanel } from '../../apps/desktop/src/playtest-panel.js';
import {SCENARIO_ACTIONS} from '../../packages/studio-test-controller/src/scenario.js';

const NOW = 2_000_000_000_000, TOKEN = 'private-human-token', DIGEST = 'a'.repeat(64);
function job(id = 'job-1', state = 'needs_approval') {
  return {
    id, targetName: 'Quiet garden', actor: 'private-actor-do-not-display', state, displayDigest: DIGEST,
    display: {
      proposal: {
        binding: { pairedSessionId: 'paired-private-id', nativeStudioId: 'native-private-id', placeId: 0,
          clientLifetimeId: 'lifetime-id', pluginArtifactHash: 'b'.repeat(64), scopeRevision: 'c'.repeat(64) },
        durationMs: 5000, observationIntervalMs: 1000, failOnRuntimeError: true,
        trustedPrivateTarget: { name: 'Quiet garden', source: 'Authenticated local pairing' },
      },
      cleanupGraceMs: 5000, requestTimeoutMs: 10000, proofMaxAgeMs: 6000, consentExpiresAt: NOW + 60_000,
      guarantee: 'observed-non-atomic', actions: ['start', 'observe-state-and-console', 'stop-owned-play'],
      raceDisclosure: 'Another Studio action can race these observations. Only owned play is stopped.',
    },
    review: { phase: 'prepared', outcome: null as string | null, code: null as string | null,
      cleanup: 'not_started', observations: 0, requiresHumanReview: false,
      logs: ['secret console text must not appear'] },
    evidence: 'native', nativeAcceptance: false,
  };
}
type JobFixture = ReturnType<typeof job>;
function terminal(id = 'job-1', patch: Partial<JobFixture['review']> = {}): JobFixture {
  const result = job(id, 'complete');
  result.review = { ...result.review, phase: 'done', outcome: 'succeeded', code: 'OK', cleanup: 'complete', ...patch };
  return result;
}
function gameplayJob(passed=false){
  const value=job(),scenario={version:1,runtimeBudgetMs:500,
    targets:[{id:'status',root:'LocalPlayer.PlayerGui',segments:['Hud','Status'],className:'Frame'}],
    steps:[{id:'opened',kind:'assert-gui',targetId:'status',property:'Visible',equals:true,withinMs:100,requireTransition:true}],capture:{required:false},
    temporaryEdits:[{id:'setup',ref:{instanceId:'private-part',sessionId:'paired-private-id',root:'Workspace',pathSegments:[],className:'Part'},expected:{Transparency:0.25},properties:{Transparency:0.5}}]};
  const report={scenarioDigest:'d'.repeat(64),subjectDigest:'e'.repeat(64),state:passed?'passed':'not_started',inputRelease:'not_started',temporary:passed?'restored':'not_started',
    steps:passed?[{id:'opened',kind:'assert-gui',outcome:'passed',expected:true,observed:true,baseline:false}]:[],capture:null as null|Record<string,unknown>,consoleCoverage:'ambiguous'};
  Object.assign(value.display.proposal,{scenario,subjectDigest:report.subjectDigest});value.display.actions=[...SCENARIO_ACTIONS];Object.assign(value.review,{scenario:report});
  if(passed){value.state='complete';value.review.phase='done';value.review.outcome='succeeded';value.review.code='OK';value.review.cleanup='complete';}
  return{value,scenario,report};
}
function layoutJob(passed=false){
  const current=gameplayJob(passed);
  Object.assign(current.scenario,{steps:[{id:'layout',kind:'assert-gui-layout',targetId:'status',minimumWidth:120,minimumHeight:40,withinMs:100}]});
  const measurement={coordinateSpace:'CoreUISafeInsets',target:{left:24,top:24,right:224,bottom:74},safeArea:{left:0,top:0,right:800,bottom:600},
    clips:[{left:0,top:0,right:400,bottom:300}],visibleChain:true,viewport:{width:800,height:644,units:'RobloxUIOffset'}};
  const row={id:'layout',kind:'assert-gui-layout',outcome:'passed',expected:'core-safe:120x40',observed:true as unknown,layout:measurement};
  Object.assign(current.report,{steps:passed?[row]:[]});return{...current,row,measurement};
}
function attributeJob(passed=false,expected:boolean|number|string=2){
  const current=gameplayJob(passed);
  Object.assign(current.scenario,{targets:[],steps:[{id:'checkpoint',kind:'assert-player-attribute',attribute:'Checkpoint',equals:expected,withinMs:100,requireTransition:true}]});
  const measurement={context:'Client',subject:'LocalPlayer',name:'Checkpoint',baseline:{present:false},observed:{present:true,value:expected}};
  const row={id:'checkpoint',kind:'assert-player-attribute',outcome:'passed',expected,observed:true as unknown,attribute:measurement};
  Object.assign(current.report,{steps:passed?[row]:[]});return{...current,row,measurement};
}

class Events {
  private listeners = new Map<string, EventListener[]>();
  addEventListener(type: string, listener: EventListener): void { this.listeners.set(type, [...this.listeners.get(type) ?? [], listener]); }
  removeEventListener(type: string, listener: EventListener): void { this.listeners.set(type, (this.listeners.get(type) ?? []).filter(value => value !== listener)); }
  count(): number { return [...this.listeners.values()].reduce((sum, values) => sum + values.length, 0); }
  dispatchEvent(event: Event): boolean { for (const listener of [...this.listeners.get(event.type) ?? []]) listener(event); return !event.defaultPrevented; }
  emit(type: string, trusted = false): void {
    // Private offline fixture only. The production controller has no trust hook.
    this.dispatchEvent({ type, isTrusted: trusted, target: this, preventDefault() {} } as unknown as Event);
  }
}
class ElementFixture extends Events {
  children: ElementFixture[] = []; parentElement: ElementFixture | null = null;
  className = ''; type = ''; hidden = false; disabled = false; open = false; tabIndex = 0;
  private content = ''; private attributes = new Map<string, string>();
  constructor(readonly tagName: string, readonly ownerDocument: DocumentFixture) { super(); }
  get textContent(): string { return this.content + this.children.map(child => child.textContent).join(''); }
  set textContent(value: string) { this.replaceChildren(); this.content = value; }
  get innerHTML(): never { throw new Error('HTML sink forbidden'); }
  set innerHTML(_value: string) { throw new Error('HTML sink forbidden'); }
  append(...children: ElementFixture[]): void { children.forEach(child => { child.parentElement = this; this.children.push(child); }); }
  replaceChildren(...children: ElementFixture[]): void {
    if (this.ownerDocument.activeElement && this.contains(this.ownerDocument.activeElement)) this.ownerDocument.activeElement = null;
    this.children.forEach(child => { child.parentElement = null; }); this.children = []; this.content = ''; this.append(...children);
  }
  setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
  contains(element: ElementFixture): boolean { return element === this || this.children.some(child => child.contains(element)); }
  all(): ElementFixture[] { return this.children.flatMap(child => [child, ...child.all()]); }
  focus(): void { this.ownerDocument.activeElement = this; }
  click(): void { this.dispatchEvent(new Event('click')); }
}
class DocumentFixture extends Events {
  visibilityState = 'visible'; activeElement: ElementFixture | null = null;
  defaultView = new Events(); root = this.createElement('div');
  createElement(tag: string): ElementFixture { return new ElementFixture(tag.toUpperCase(), this); }
  visibility(state: string): void { this.visibilityState = state; this.emit('visibilitychange'); }
}
interface Call { path: string; init: RequestInit; body: unknown }
type Handler = (call: Call) => Promise<Response>;
function fixture(t: TestContext, initial: JobFixture[] = [job()], signedIn = true, visible = true, autoApprove?: () => boolean) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: NOW });
  const doc = new DocumentFixture(), calls: Call[] = [];
  if (!visible) doc.visibilityState = 'hidden';
  let jobs = structuredClone(initial), token = TOKEN, authenticated = signedIn;
  let handler: Handler = async call => {
    if (call.init.method === 'GET') return Response.json({ jobs });
    const input = call.body as { id: string };
    const current = jobs.find(job => job.id === input.id)!;
    current.state = call.path.endsWith('/approve') ? 'running' : 'cancelled';
    return Response.json({ job: current });
  };
  const transport: typeof fetch = async (input, init) => {
    const call = { path: String(input), init: init!, body: init?.body ? JSON.parse(String(init.body)) as unknown : undefined };
    calls.push(call); return handler(call);
  };
  const panel = startPlaytestPanel({ root: doc.root as unknown as HTMLElement,
    token: () => token, isSignedIn: () => authenticated, transport, ...(autoApprove ? { autoApprove } : {}) });
  t.after(() => panel.stop());
  return {
    panel, doc, root: doc.root, calls,
    handler(value: Handler) { handler = value; }, jobs(value: JobFixture[]) { jobs = structuredClone(value); },
    auth(value: boolean, nextToken = token) { authenticated = value; token = nextToken; },
    posts() { return calls.filter(call => call.init.method === 'POST'); },
  };
}
type Fixture = ReturnType<typeof fixture>;
const flush = async () => { for (let index = 0; index < 5; index++) await new Promise<void>(resolve => setImmediate(resolve)); };
function button(f: Fixture, label: string): ElementFixture {
  const result = f.root.all().find(element => element.tagName === 'BUTTON' && element.textContent === label);
  assert.ok(result, 'Expected button: ' + label); return result;
}
function details(f: Fixture): ElementFixture { const value = f.root.all().find(element => element.tagName === 'DETAILS'); assert.ok(value); return value; }
function deferred() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>(done => { resolve = done; }); return { promise, resolve };
}
function fieldValues(f: Fixture): Map<string, string> {
  const children = details(f).all().filter(element => element.tagName === 'DT' || element.tagName === 'DD');
  const result = new Map<string, string>();
  for (let index = 0; index < children.length; index += 2) result.set(children[index]!.textContent, children[index + 1]!.textContent);
  return result;
}

test('hidden before sign-in: no request, prefill, consent or empty panel', async t => {
  const f = fixture(t, [job()], false);
  assert.equal(f.root.hidden, true); assert.equal(f.root.children.length, 0);
  await f.panel.refresh(); t.mock.timers.tick(10_000); await flush();
  assert.equal(f.calls.length, 0); assert.equal(f.root.textContent, '');
  f.auth(true); t.mock.timers.tick(250); await flush();
  assert.equal(f.calls.length, 1); assert.equal(f.root.hidden, false); assert.equal(f.posts().length, 0);
});

test('scenario panel preserves exact temporary baselines and displays observed transitions with unattested capture context',async t=>{
  const pending=gameplayJob(),f=fixture(t,[pending.value]);await f.panel.refresh();
  assert.equal(fieldValues(f).get('display.proposal.scenario.temporaryEdits[0].expected.Transparency'),'0.25');
  assert.equal(fieldValues(f).get('display.proposal.scenario.temporaryEdits[0].properties.Transparency'),'0.5');
  const finished=gameplayJob(true);finished.scenario.capture.required=true;finished.value.review.outcome='failed';finished.value.review.code='UNSUPPORTED_TOOL';
  finished.report.capture={id:'owned-image',sha256:'f'.repeat(64),bytes:128,mimeType:'image/png',width:128,height:128,context:'unattested',nativeAcceptance:false};
  f.jobs([finished.value]);await f.panel.refresh();assert.match(f.root.textContent,/opened/);assert.match(f.root.textContent,/Observed true/);
  assert.equal(button(f,'View capture · Context unverified').disabled,false);assert.equal(f.posts().length,0);
});

test('scenario approval makes each finite operation and exact temporary restoration readable before consent',async t=>{
  const pending=gameplayJob();pending.scenario.targets[0]!.className='TextLabel';
  pending.scenario.targets.push({id:'button',root:'LocalPlayer.PlayerGui',segments:['Hud','Interact'],className:'TextButton'});
  Object.assign(pending.scenario,{runtimeBudgetMs:800,steps:[
    {id:'walk',kind:'hold-key',key:'W',holdMs:100},
    {id:'click',kind:'click-gui',targetId:'button'},
    {id:'distance',kind:'assert-displacement',minimumStuds:0.5},
    {id:'visible',kind:'assert-gui',targetId:'status',property:'Visible',equals:true,withinMs:100,requireTransition:true},
    {id:'text',kind:'assert-text',targetId:'status',equals:'Open',withinMs:100,requireTransition:false},
  ]});pending.scenario.capture.required=true;
  const f=fixture(t,[pending.value]);await f.panel.refresh();const audit=details(f);
  const readable=f.root.all().filter(element=>element.tagName==='LI'&&!audit.contains(element)).map(element=>element.textContent);
  assert.deepEqual(readable,[
    'Hold W for 100 ms.',
    'Click PlayerGui → Hud → Interact (TextButton).',
    'Assert horizontal movement of at least 0.5 studs.',
    'Assert PlayerGui → Hud → Status is visible within 100 ms. Require a transition from its initial value.',
    'Assert PlayerGui → Hud → Status text equals "Open" within 100 ms. An already satisfied result is allowed.',
    'Part in Workspace · Transparency: 0.25 → 0.5.',
  ]);
  assert.ok(f.root.all().some(element=>element.tagName==='P'&&element.textContent==='Scenario plan · 5 steps · 800 ms Client execution limit.'));
  assert.match(f.root.textContent,/Restore exact prior values after owned Play stops/);assert.match(f.root.textContent,/Required Client capture: unverified/);
  assert.equal(audit.open,false);assert.equal(fieldValues(f).get('display.proposal.scenario.steps[0].holdMs'),'100');assert.equal(fieldValues(f).get('displayDigest'),DIGEST);
  assert.equal(f.posts().length,0);button(f,'Run test').emit('click',true);await flush();assert.equal(f.posts().length,1);
  assert.deepEqual(f.posts()[0]!.body,{id:pending.value.id,displayDigest:DIGEST},'the readable projection cannot replace the exact approval digest');
});

test('player attribute consent keeps Client scope, exact values and measured presence visible',async t=>{
  const pending=attributeJob(false,''),f=fixture(t,[pending.value]);await f.panel.refresh();
  assert.match(f.root.textContent,/LocalPlayer attribute "Checkpoint" equals "" within 100 ms/);
  assert.match(f.root.textContent,/Require a transition from its initial value/);assert.match(f.root.textContent,/Client observation; server authority is unverified/);
  button(f,'Run test').emit('click',true);await flush();assert.deepEqual(f.posts()[0]!.body,{id:pending.value.id,displayDigest:DIGEST});
  for(const expected of ['',false,0,2]){
    const finished=attributeJob(true,expected);f.jobs([finished.value]);await f.panel.refresh();
    assert.ok(f.root.textContent.includes('checkpoint · passed · Expected '+JSON.stringify(expected)+' · Observed '+JSON.stringify(expected)));
    assert.ok(f.root.textContent.includes('Client player attribute "Checkpoint": '+JSON.stringify(expected)+'. Initial value: absent.'));
    assert.match(f.root.textContent,/Server authority is unverified/);
  }
});

test('player attribute panel refuses borrowed authority, ambiguous presence and contradictory pass/failure rows',async t=>{
  const pending=attributeJob();pending.value.state='running';pending.value.review.phase='observing';pending.report.state='running';
  const f=fixture(t,[pending.value]);await f.panel.refresh();
  const mutations:[string,(value:ReturnType<typeof attributeJob>)=>void][]=[
    ['server',value=>{value.measurement.context='Server';}],['subject',value=>{value.measurement.subject='OtherPlayer';}],
    ['name',value=>{value.measurement.name='Foreign';}],['value',value=>{value.measurement.observed.value=3;}],
    ['missing',value=>{Object.assign(value.measurement.observed,{present:false});}],
    ['missing measurement',value=>{Reflect.deleteProperty(value.row,'attribute');}],
    ['already satisfied',value=>{Object.assign(value.measurement.baseline,{present:true,value:2});}],
    ['unmeasured failure',value=>{value.value.review.code='ASSERTION_FAILED';value.value.review.outcome='failed';value.report.state='failed';value.row.outcome='failed';value.row.observed=null;Reflect.deleteProperty(value.row,'attribute');}],
    ['extra authority',value=>{Object.assign(value.measurement,{code:'unapproved()'});}],
  ];
  for(const[name,mutate]of mutations){const malformed=attributeJob(true);mutate(malformed);f.jobs([malformed.value]);await f.panel.refresh();
    assert.equal(button(f,'Stop').disabled,true,name);assert.match(f.root.textContent,/refresh|status/i,name);}
  assert.equal(f.posts().length,0);
});

test('layout consent is readable and measured GUI pixels remain distinct from camera viewport units',async t=>{
  const pending=layoutJob(),f=fixture(t,[pending.value]);await f.panel.refresh();
  assert.match(f.root.textContent,/at least 120 x 40 GUI pixels/);assert.match(f.root.textContent,/Core UI safe area and clipping ancestors, within 100 ms/);
  assert.match(f.root.textContent,/Layout snapshot; occlusion and device input are unverified/);assert.equal(details(f).open,false);
  assert.equal(fieldValues(f).get('display.proposal.scenario.steps[0].minimumWidth'),'120');
  button(f,'Run test').emit('click',true);await flush();assert.deepEqual(f.posts()[0]!.body,{id:pending.value.id,displayDigest:DIGEST});
  const finished=layoutJob(true);f.jobs([finished.value]);await f.panel.refresh();
  assert.match(f.root.textContent,/layout · passed · Expected at least 120 x 40 GUI pixels · Observed true/);
  assert.doesNotMatch(f.root.textContent,/Expected core-safe:/);
  assert.match(f.root.textContent,/Layout snapshot: 200 x 50 GUI pixels at \(24, 24\)/);assert.match(f.root.textContent,/Core UI safe area: 800 x 600 GUI pixels/);
  assert.match(f.root.textContent,/Clipping ancestors: 1/);assert.match(f.root.textContent,/Camera viewport: 800 x 644 Roblox UI offset units; separate from GUI pixels/);
  assert.match(f.root.textContent,/Overlap and device behavior unverified/);
  const evidence=f.root.all().find(element=>element.tagName==='DETAILS'&&element.textContent.includes('Camera viewport:'));assert.ok(evidence);assert.equal(evidence.open,false);
  const summary=f.root.all().find(element=>element.tagName==='P'&&element.textContent.startsWith('Layout snapshot:'));assert.ok(summary);assert.doesNotMatch(summary.textContent,/Camera viewport/);
});

test('layout evidence refreshes in an unchanged running state and rejects contradictory measurements',async t=>{
  const active=layoutJob();active.value.state='running';active.value.review.phase='observing';active.report.state='running';
  const f=fixture(t,[active.value]);await f.panel.refresh();Object.assign(active.report,{steps:[active.row]});
  f.jobs([active.value]);await f.panel.refresh();assert.match(f.root.textContent,/Layout snapshot: 200 x 50/);
  const mutations:[string,(value:ReturnType<typeof layoutJob>)=>void][]=[
    ['size',value=>{value.measurement.target.right=100;}],['clipping',value=>{value.measurement.clips[0]!.right=100;}],
    ['visibility',value=>{value.measurement.visibleChain=false;}],['safe origin',value=>{value.measurement.safeArea.top=1;}],
    ['too many clips',value=>{value.measurement.clips=Array.from({length:9},()=>value.measurement.safeArea);}],
    ['units',value=>{value.measurement.viewport.units='pixels';}],['missing measurement',value=>{Reflect.deleteProperty(value.row,'layout');}],
    ['unmeasured failure',value=>{value.value.review.code='ASSERTION_FAILED';value.value.review.outcome='failed';value.report.state='failed';value.row.outcome='failed';value.row.observed=null;Reflect.deleteProperty(value.row,'layout');}],
  ];
  for(const[name,mutate]of mutations){const malformed=layoutJob(true);mutate(malformed);f.jobs([malformed.value]);await f.panel.refresh();
    assert.equal(button(f,'Stop').disabled,true,name);assert.match(f.root.textContent,/refresh|status/i);}
  assert.equal(f.posts().length,0);
});

test('terminal scenario keeps measured rows separate from outer outcome and required Client capture evidence',async t=>{
  const pending=gameplayJob();pending.scenario.capture.required=true;const f=fixture(t,[pending.value]);await f.panel.refresh();
  const finished=gameplayJob(true);finished.scenario.capture.required=true;finished.value.review.outcome='failed';finished.value.review.code='UNSUPPORTED_TOOL';
  f.jobs([finished.value]);await f.panel.refresh();assert.match(f.root.textContent,/Result: failed · Code: UNSUPPORTED_TOOL · Cleanup: complete/);
  assert.match(f.root.textContent,/Measured steps: passed/);assert.match(f.root.textContent,/Required Client capture: still unverified/);assert.match(f.root.textContent,/does not attest Client context/);
  finished.report.capture={id:'owned-image',sha256:'f'.repeat(64),bytes:128,mimeType:'image/png',width:128,height:128,context:'unattested',nativeAcceptance:false};
  f.jobs([finished.value]);await f.panel.refresh();assert.match(f.root.textContent,/The retained image has unverified context/);assert.match(f.root.textContent,/Observed true/);
  assert.equal(button(f,'View capture · Context unverified').disabled,false);assert.match(f.root.textContent,/Native acceptance unverified/);
  finished.value.review.code='BINDING_CHANGED';f.jobs([finished.value]);await f.panel.refresh();assert.match(f.root.textContent,/Code: BINDING_CHANGED/);assert.doesNotMatch(f.root.textContent,/Code: UNSUPPORTED_TOOL/);
  assert.equal(f.posts().length,0);
});

test('active scenario evidence refreshes within the same state without retaining detached control authority',async t=>{
  const active=gameplayJob();active.value.state='running';active.value.review.phase='observing';active.report.state='running';
  const f=fixture(t,[active.value]);await f.panel.refresh();const oldStop=button(f,'Stop');
  Object.assign(active.report,{state:'failed',steps:[{id:'opened',kind:'assert-gui',outcome:'failed',expected:true,observed:false,baseline:false}]});
  f.jobs([active.value]);await f.panel.refresh();assert.match(f.root.textContent,/Measured steps: failed/);assert.match(f.root.textContent,/opened · failed · Expected true · Observed false/);
  assert.equal(oldStop.count(),0);oldStop.emit('click',true);assert.equal(f.posts().length,0);button(f,'Stop').emit('click',true);await flush();assert.equal(f.posts().length,1);
});

test('approval summary rejects unknown operations, extra capture authority and waits beyond its fixed bound',async t=>{
  const f=fixture(t,[gameplayJob().value]);await f.panel.refresh();
  for(const variant of ['operation','capture','budget']){
    const malformed=gameplayJob();
    if(variant==='operation')Object.assign(malformed.scenario.steps[0]!,{kind:'execute-luau',code:'unapproved()'});
    if(variant==='capture')Object.assign(malformed.scenario.capture,{url:'https://unapproved.invalid'});
    if(variant==='budget')malformed.scenario.steps[0]!.withinMs=1000;
    f.jobs([malformed.value]);await f.panel.refresh();assert.equal(button(f,'Run test').disabled,true,variant);assert.equal(f.posts().length,0);
  }
});

for(const field of ['expected','observed','baseline']as const)test('scenario panel rejects contradictory '+field+' evidence before displaying completion',async t=>{
  const f=fixture(t,[gameplayJob().value]);await f.panel.refresh();const malformed=gameplayJob(true);
  if(field==='baseline')Object.assign(malformed.report.steps[0]!,{baseline:'not-a-boolean'});else malformed.report.steps[0]![field]=false;
  f.jobs([malformed.value]);await f.panel.refresh();assert.match(f.root.textContent,/status|refresh/i);assert.equal(button(f,'Run test').disabled,true);assert.equal(f.posts().length,0);
});

test('empty jobs and historical terminal jobs do not create a panel', async t => {
  const f = fixture(t, [terminal('old'), job('cancelled', 'cancelled')]);
  await f.panel.refresh(); assert.equal(f.root.hidden, true);
  f.jobs([]); await f.panel.refresh(); assert.equal(f.root.hidden, true); assert.equal(f.posts().length, 0);
});

test('renders the latest three actual active jobs with every exact read-only display field', async t => {
  const actual = job(); const f = fixture(t, [job('old-1'), job('old-2'), job('recent'), actual]);
  await f.panel.refresh();
  assert.equal(f.root.all().filter(element => element.tagName === 'ARTICLE').length, 3);
  assert.equal(f.root.all().filter(element => element.tagName === 'H3')[0]!.textContent, 'Playtest · Quiet garden');
  assert.match(f.root.textContent, /5 s · Local, unpublished place/);
  assert.ok(f.root.textContent.includes(actual.display.raceDisclosure));
  const fields = fieldValues(f);
  const expected = new Map<string, string>();
  function flatten(value: unknown, path: string): void {
    if (Array.isArray(value)) value.forEach((child, index) => flatten(child, path + '[' + index + ']'));
    else if (value && typeof value === 'object') Object.entries(value).forEach(([key, child]) => flatten(child, path + '.' + key));
    else expected.set(path, String(value));
  }
  flatten(actual.display, 'display'); expected.set('displayDigest', DIGEST);
  assert.deepEqual(fields, expected); assert.equal(details(f).open, false);
  assert.doesNotMatch(f.root.textContent, /private-actor-do-not-display|private-human-token|secret console/);
  assert.ok(!f.root.all().some(element => ['INPUT', 'TEXTAREA', 'PRE', 'SELECT', 'IFRAME'].includes(element.tagName)));
  assert.equal(f.root.getAttribute('aria-label'), 'Playtests'); assert.equal(f.root.getAttribute('aria-busy'), 'false');
  assert.ok(f.root.all().filter(element => element.tagName === 'BUTTON').every(element => element.type === 'button'));
});

test('target text is never HTML and fields are captured independently of the returned object', async t => {
  const target = '<img src=x onerror=send()>', actual = job(); actual.targetName = target;
  const f = fixture(t, [actual]); await f.panel.refresh();
  assert.equal(f.root.all().find(element => element.tagName === 'H3')!.textContent, 'Playtest · ' + target);
  assert.equal(f.root.all().filter(element => element.tagName === 'IMG').length, 0);
  actual.display.proposal.durationMs = 300_000;
  assert.equal(fieldValues(f).get('display.proposal.durationMs'), '5000');
});

test('only a trusted current click sends the exact approval payload with browser-origin fetch', async t => {
  const f = fixture(t); await f.panel.refresh();
  const run = button(f, 'Run test');
  run.click(); run.emit('click'); await flush(); assert.equal(f.posts().length, 0);
  run.emit('click', true); run.emit('click', true);
  assert.equal(f.posts().length, 1); assert.equal(f.root.getAttribute('aria-busy'), 'true');
  assert.equal(button(f, 'Cancel').disabled, true);
  const call = f.posts()[0]!;
  assert.equal(call.path, '/v1/playtests/approve'); assert.deepEqual(call.body, { id: 'job-1', displayDigest: DIGEST });
  assert.deepEqual(call.init.headers, { Authorization: 'Bearer ' + TOKEN, Accept: 'application/json', 'Content-Type': 'application/json' });
  assert.equal(call.init.credentials, 'same-origin'); assert.equal(call.init.redirect, 'error'); assert.equal(call.init.cache, 'no-store');
  assert.ok(!('Origin' in (call.init.headers as Record<string, string>)));
  await flush(); assert.match(f.root.textContent, /Testing…/); assert.equal(button(f, 'Stop').disabled, false);
  run.emit('click', true); assert.equal(f.posts().length, 1);
});

test('Cancel and running Stop are trusted, current, scoped POSTs', async t => {
  const f = fixture(t); await f.panel.refresh();
  const cancel = button(f, 'Cancel'); cancel.click(); assert.equal(f.posts().length, 0);
  cancel.emit('click', true); await flush();
  assert.equal(f.posts()[0]!.path, '/v1/playtests/cancel'); assert.deepEqual(f.posts()[0]!.body, { id: 'job-1' });
  assert.match(f.root.textContent, /Test cancelled/); cancel.emit('click', true); assert.equal(f.posts().length, 1);
  f.jobs([job('running-job', 'running')]); await f.panel.refresh();
  button(f, 'Stop').emit('click', true); await flush();
  assert.deepEqual(f.posts()[1]!.body, { id: 'running-job' });
});

test('changed ID, digest, scope or state invalidates detached approval and cancellation buttons', async t => {
  const f = fixture(t); await f.panel.refresh();
  for (const variant of ['id', 'digest', 'scope', 'state']) {
    f.jobs([job()]); await f.panel.refresh();
    const oldRun = button(f, 'Run test'), oldCancel = button(f, 'Cancel'), changed = job();
    if (variant === 'id') changed.id = 'replacement';
    if (variant === 'digest') changed.displayDigest = 'd'.repeat(64);
    if (variant === 'scope') changed.display.proposal.durationMs = 6000;
    if (variant === 'state') changed.state = 'running';
    f.jobs([changed]); await f.panel.refresh();
    oldRun.emit('click', true); oldCancel.emit('click', true);
    assert.equal(f.posts().length, 0, variant); assert.equal(oldRun.count(), 0); assert.equal(oldCancel.count(), 0);
  }
});

test('ordinary polling preserves focus, the row and expanded consent details', async t => {
  const f = fixture(t); await f.panel.refresh();
  const original = button(f, 'Run test'), expanded = details(f); expanded.open = true; original.focus();
  t.mock.timers.tick(1750); await flush(); assert.equal(f.calls.length, 1);
  t.mock.timers.tick(250); await flush(); assert.equal(f.calls.length, 2);
  assert.equal(button(f, 'Run test'), original); assert.equal(details(f), expanded); assert.equal(expanded.open, true);
  assert.equal(f.doc.activeElement, original); assert.equal(f.posts().length, 0);
  f.jobs([job('job-1', 'running')]); await f.panel.refresh();
  assert.equal(details(f).open, true); assert.equal(f.doc.activeElement?.tagName, 'H3');
});

test('hidden tabs do not poll; visibility changes abort reads and fence late results', async t => {
  const f = fixture(t); await f.panel.refresh();
  const late = deferred(); f.handler(async () => late.promise);
  const pending = f.panel.refresh(), call = f.calls.at(-1)!;
  f.doc.visibility('hidden'); assert.equal(call.init.signal!.aborted, true); assert.equal(f.root.hidden, true);
  t.mock.timers.tick(10_000); await flush(); assert.equal(f.calls.length, 2);
  f.handler(async () => Response.json({ jobs: [job('fresh')] })); f.doc.visibility('visible'); await flush();
  assert.equal(f.calls.length, 3);
  late.resolve(Response.json({ jobs: [job('obsolete')] })); await pending; await flush();
  button(f, 'Run test').emit('click', true); assert.deepEqual(f.posts()[0]!.body, { id: 'fresh', displayDigest: DIGEST });
});

test('initially hidden tabs make no requests until visible', async t => {
  const f = fixture(t, [job()], true, false);
  await f.panel.refresh(); t.mock.timers.tick(10_000); await flush();
  assert.equal(f.calls.length, 0); assert.equal(f.root.hidden, true);
  f.doc.visibility('visible'); await flush(); assert.equal(f.calls.length, 1);
});

test('auth loss and token rotation abort work and fence late responses', async t => {
  const f = fixture(t); await f.panel.refresh();
  const late = deferred(); f.handler(async () => late.promise);
  const pending = f.panel.refresh(), call = f.calls.at(-1)!;
  f.auth(false); t.mock.timers.tick(250); await flush();
  assert.equal(call.init.signal!.aborted, true); assert.equal(f.root.hidden, true); assert.equal(f.root.textContent, '');
  t.mock.timers.tick(10_000); await flush(); assert.equal(f.calls.length, 2);
  const fresh = deferred(); f.handler(async () => fresh.promise); f.auth(true, 'rotated-token');
  t.mock.timers.tick(250); await flush(); assert.equal(f.calls.length, 3);
  late.resolve(Response.json({ jobs: [job('wrong-user-job')] })); await pending; await flush();
  assert.equal(f.root.hidden, true); assert.equal(f.root.getAttribute('aria-busy'), 'true');
  fresh.resolve(Response.json({ jobs: [job('current-user-job')] })); await flush();
  assert.equal(f.root.hidden, false); assert.equal((f.calls[2]!.init.headers as Record<string, string>).Authorization, 'Bearer rotated-token');
  const rotation = deferred(); f.handler(async () => rotation.promise); const rotating = f.panel.refresh();
  const rotatingCall = f.calls.at(-1)!; f.auth(true, 'third-token'); const replacement = f.panel.refresh();
  assert.equal(rotatingCall.init.signal!.aborted, true);
  f.panel.stop(); rotation.resolve(Response.json({ jobs: [] })); await rotating; await replacement; await flush();
  assert.equal(f.root.hidden, true);
});

test('click-time auth and visibility checks forbid stale commands before the watchdog runs', async t => {
  const f = fixture(t); await f.panel.refresh(); const oldRun = button(f, 'Run test');
  f.auth(false); oldRun.emit('click', true); assert.equal(f.posts().length, 0); assert.equal(f.root.hidden, true);
  f.auth(true); await f.panel.refresh(); const current = button(f, 'Cancel');
  f.doc.visibilityState = 'hidden'; current.emit('click', true); assert.equal(f.posts().length, 0); assert.equal(f.root.hidden, true);
});

test('stop cleans every listener and timer, aborts, hides and permanently fences late work', async t => {
  const f = fixture(t); await f.panel.refresh();
  const oldRun = button(f, 'Run test'), late = deferred(); f.handler(async () => late.promise);
  const pending = f.panel.refresh(), call = f.calls.at(-1)!;
  assert.equal(f.doc.count(), 1); assert.equal(f.doc.defaultView.count(), 2);
  f.panel.stop(); f.panel.stop();
  assert.equal(call.init.signal!.aborted, true); assert.equal(f.doc.count(), 0); assert.equal(f.doc.defaultView.count(), 0);
  assert.equal(oldRun.count(), 0); assert.equal(f.root.hidden, true); assert.equal(f.root.children.length, 0);
  t.mock.timers.tick(60_000); f.doc.visibility('visible'); f.doc.defaultView.emit('pageshow');
  await f.panel.refresh(); oldRun.emit('click', true); assert.equal(f.calls.length, 2);
  late.resolve(Response.json({ jobs: [job()] })); await pending; await flush(); assert.equal(f.root.textContent, '');
});

test('pagehide aborts a POST; pageshow only reads status and never replays consent', async t => {
  const f = fixture(t); await f.panel.refresh(); const late = deferred();
  f.handler(async call => call.init.method === 'POST' ? late.promise : Response.json({ jobs: [job()] }));
  button(f, 'Run test').emit('click', true); const call = f.posts()[0]!;
  f.doc.defaultView.emit('pagehide'); assert.equal(call.init.signal!.aborted, true); assert.equal(f.root.hidden, true);
  t.mock.timers.tick(10_000); await flush(); assert.equal(f.calls.length, 2);
  f.doc.defaultView.emit('pageshow'); await flush();
  late.resolve(Response.json({ job: job('job-1', 'running') })); await flush();
  assert.equal(f.posts().length, 1); assert.equal(button(f, 'Run test').disabled, true);
});

test('sign-out during a POST clears private data and a late receipt cannot change a new session', async t => {
  const f = fixture(t); await f.panel.refresh(); const late = deferred();
  f.handler(async call => call.init.method === 'POST' ? late.promise : Response.json({ jobs: [job('new-session-job')] }));
  button(f, 'Run test').emit('click', true); const post = f.posts()[0]!;
  f.auth(false); t.mock.timers.tick(250); await flush();
  assert.equal(post.init.signal!.aborted, true); assert.equal(f.root.textContent, ''); assert.equal(f.root.hidden, true);
  const callCount = f.calls.length; t.mock.timers.tick(5000); await flush(); assert.equal(f.calls.length, callCount);
  f.auth(true, 'new-session-token'); await f.panel.refresh();
  late.resolve(Response.json({ job: terminal('job-1') })); await flush();
  assert.doesNotMatch(f.root.textContent, /Test finished/); assert.equal(button(f, 'Run test').disabled, false);
  button(f, 'Run test').emit('click', true); assert.deepEqual(f.posts()[1]!.body, { id: 'new-session-job', displayDigest: DIGEST });
});

test('ambiguous approval failures show a bounded error, refresh status and never retry the POST', async t => {
  const f = fixture(t); await f.panel.refresh();
  f.handler(async call => {
    if (call.init.method === 'POST') throw new Error('private transport details ' + TOKEN);
    return Response.json({ jobs: [job()] });
  });
  button(f, 'Run test').emit('click', true); await flush();
  assert.equal(f.posts().length, 1); assert.equal(f.calls.at(-1)!.init.method, 'GET');
  assert.match(f.root.textContent, /Couldn’t confirm the request/); assert.doesNotMatch(f.root.textContent, /private transport details|private-human-token/);
  assert.equal(button(f, 'Run test').disabled, true); button(f, 'Run test').emit('click', true);
  button(f, 'Refresh status').emit('click', true); await flush(); t.mock.timers.tick(2000); await flush();
  assert.equal(f.posts().length, 1);
  button(f, 'Cancel').emit('click', true); await flush(); assert.equal(f.posts().length, 2);
  assert.equal(button(f, 'Cancel').disabled, true);
});

test('stale POST receipt IDs, digests, display scopes and states are refused', async t => {
  const f = fixture(t); await f.panel.refresh();
  for (const variant of ['id', 'digest', 'scope', 'state', 'cancelled']) {
    const id = 'job-' + variant, returned = job(id, 'running');
    f.handler(async () => Response.json({ jobs: [job(id)] })); await f.panel.refresh();
    if (variant === 'id') returned.id = 'foreign-job';
    if (variant === 'digest') returned.displayDigest = 'b'.repeat(64);
    if (variant === 'scope') returned.display.proposal.durationMs = 9000;
    if (variant === 'state') returned.state = 'needs_approval';
    if (variant === 'cancelled') returned.state = 'cancelled';
    f.handler(async call => call.init.method === 'POST' ? Response.json({ job: returned }) : Response.json({ jobs: [job(id)] }));
    button(f, 'Run test').emit('click', true); await flush();
    assert.match(f.root.textContent, /Couldn’t confirm the request/, variant);
    assert.doesNotMatch(f.root.textContent, /Testing…/); assert.equal(button(f, 'Run test').disabled, true, variant);
  }
  assert.equal(f.posts().length, 5);
});

test('cancellation refuses stale IDs, digests and active-state receipts without retry', async t => {
  const f = fixture(t); await f.panel.refresh();
  for (const variant of ['id', 'digest', 'running', 'needs_approval']) {
    const id = 'cancel-' + variant, returned = job(id, 'cancelled');
    f.handler(async () => Response.json({ jobs: [job(id, 'running')] })); await f.panel.refresh();
    if (variant === 'id') returned.id = 'another-job';
    if (variant === 'digest') returned.displayDigest = 'f'.repeat(64);
    if (variant === 'running' || variant === 'needs_approval') returned.state = variant;
    f.handler(async call => call.init.method === 'POST' ? Response.json({ job: returned }) : Response.json({ jobs: [job(id, 'running')] }));
    button(f, 'Stop').emit('click', true); await flush();
    assert.match(f.root.textContent, /Couldn’t confirm the request/); assert.equal(button(f, 'Stop').disabled, true);
    button(f, 'Stop').emit('click', true);
  }
  assert.equal(f.posts().length, 4);
});

test('expired consent disables approval without silently renewing or cancelling it', async t => {
  const actual = job(); actual.display.consentExpiresAt = NOW + 500;
  const f = fixture(t, [actual]); await f.panel.refresh();
  assert.equal(button(f, 'Run test').disabled, false);
  t.mock.timers.tick(500); await flush(); assert.equal(button(f, 'Run test').disabled, true);
  button(f, 'Run test').emit('click', true); assert.equal(f.posts().length, 0); assert.equal(button(f, 'Cancel').disabled, false);
});

test('completion is neutral and evidence-labelled; failures and unknown cleanup require attention', async t => {
  const f = fixture(t, [job('job-1', 'running')]); await f.panel.refresh();
  f.jobs([terminal()]); await f.panel.refresh();
  assert.match(f.root.textContent, /Test finished/); assert.match(f.root.textContent, /Native evidence · Native acceptance unverified/);
  assert.ok(!f.root.all().some(element => /success|green/.test(element.className)));
  const failed = terminal('job-1', { outcome: 'failed', code: 'RUNTIME_ERROR' }); failed.evidence = 'fixture';
  f.jobs([failed]); await f.panel.refresh();
  assert.match(f.root.textContent, /Fixture evidence · Native acceptance unverified/);
  assert.ok(f.root.all().some(element => element.textContent === 'Test finished' && element.className.includes('danger')));
  for (const patch of [{ cleanup: 'unknown' }, { requiresHumanReview: true }, { outcome: 'new-unknown-outcome' }, { phase: 'stopping' }, { code: 'RUNTIME_ERROR' }]) {
    f.jobs([terminal('job-1', patch)]); await f.panel.refresh(); assert.match(f.root.textContent, /Needs review/);
  }
  assert.doesNotMatch(f.root.textContent, /perfect|all tests passed|secret console/);
  f.jobs([]); await f.panel.refresh(); assert.equal(f.root.hidden, true);
});

test('malformed tiny fields, actions and private target metadata fail closed', async t => {
  const f = fixture(t); await f.panel.refresh();
  const variants: ((value: Record<string, any>) => void)[] = [
    value => { value.targetName = { name: 'coercion forbidden' }; },
    value => { value.actor = {}; }, value => { value.targetName = 'x'.repeat(257); },
    value => { value.displayDigest = 'g'.repeat(64); }, value => { value.state = 'prepared'; },
    value => { value.display.proposal.binding.placeId = 123; },
    value => { value.display.proposal.binding.pairedSessionId = {}; },
    value => { value.display.proposal.durationMs = '5000'; },
    value => { value.display.proposal.observationIntervalMs = -1; },
    value => { value.display.proposal.failOnRuntimeError = 'true'; },
    value => { value.display.proposal.trustedPrivateTarget.source = false; },
    value => { value.display.proposal.binding.rawLogs = 'Not consent'; },
    value => { value.display.proposal.script = 'do not render'; },
    value => { value.display.path = 'private/path'; },
    value => { value.display.raceDisclosure = ''; }, value => { delete value.display.proofMaxAgeMs; },
    value => { value.display.guarantee = 'atomic'; }, value => { value.display.actions.push('run-code'); },
    value => { value.display.actions.reverse(); }, value => { value.nativeAcceptance = true; },
    value => { value.evidence = 'success'; }, value => { value.review.observations = {}; },
  ];
  const original = button(f, 'Run test');
  for (const change of variants) {
    const malformed = structuredClone(job()); change(malformed);
    f.handler(async () => Response.json({ jobs: [malformed] })); await f.panel.refresh();
    assert.equal(button(f, 'Run test'), original); assert.equal(original.disabled, true);
    original.emit('click', true); assert.equal(f.posts().length, 0);
  }
  f.handler(async () => Response.json({ jobs: [job(), job()] })); await f.panel.refresh(); assert.equal(original.disabled, true);
  f.handler(async () => Response.json({ jobs: [job()] })); await f.panel.refresh(); assert.equal(original.disabled, false);
});

test('response byte bounds apply while streaming, including unknown fields and error bodies', async t => {
  const f = fixture(t); await f.panel.refresh();
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(128 * 1024)); controller.enqueue(new Uint8Array(1)); },
    cancel() { cancelled = true; },
  });
  f.handler(async () => new Response(stream, { headers: { 'Content-Type': 'application/json' } })); await f.panel.refresh();
  assert.equal(cancelled, true); assert.equal(button(f, 'Run test').disabled, true);
  for (const response of [
    Response.json({ jobs: [job()] }, { headers: { 'Content-Length': String(128 * 1024 + 1) } }),
    Response.json({ jobs: [job()], extra: 'é'.repeat(128 * 1024) }),
    new Response(new Uint8Array([0xff]), { headers: { 'Content-Type': 'application/json' } }),
    new Response('{}', { headers: { 'Content-Type': 'text/html' } }),
    Response.json({ jobs: [job()] }, { status: 202 }),
    Response.json({ error: TOKEN }, { status: 403 }),
    new Response('{', { headers: { 'Content-Type': 'application/json' } }),
  ]) {
    f.handler(async () => response); await f.panel.refresh(); assert.equal(button(f, 'Run test').disabled, true);
    assert.doesNotMatch(f.root.textContent, /private-human-token/);
  }
});

test('body reads abort on visibility loss even after response headers arrive', async t => {
  const f = fixture(t); await f.panel.refresh();
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({ start() {}, cancel() { cancelled = true; } });
  f.handler(async () => new Response(stream, { headers: { 'Content-Type': 'application/json' } }));
  const pending = f.panel.refresh(); await flush(); f.doc.visibility('hidden'); await pending; await flush();
  assert.equal(cancelled, true); assert.equal(f.root.hidden, true);
});

test('a stalled POST times out, reports uncertainty and only starts a status read', async t => {
  const f = fixture(t); await f.panel.refresh(); const late = deferred();
  f.handler(async call => call.init.method === 'POST' ? late.promise : Response.json({ jobs: [job()] }));
  button(f, 'Run test').emit('click', true); const post = f.posts()[0]!;
  t.mock.timers.tick(15_000); await flush();
  assert.equal(post.init.signal!.aborted, true); assert.equal(f.posts().length, 1);
  assert.match(f.root.textContent, /Couldn’t confirm the request/); assert.equal(f.calls.at(-1)!.init.method, 'GET');
  late.resolve(Response.json({ job: job('job-1', 'running') })); await flush();
  assert.doesNotMatch(f.root.textContent, /Testing…/); assert.equal(button(f, 'Run test').disabled, true);
});

test('manual refresh coalesces an in-flight read and polling never overlaps it', async t => {
  const f = fixture(t); await f.panel.refresh(); const late = deferred();
  f.handler(async () => late.promise); const first = f.panel.refresh(), second = f.panel.refresh();
  assert.equal(first, second); t.mock.timers.tick(5000); await flush(); assert.equal(f.calls.length, 2);
  late.resolve(Response.json({ jobs: [job()] })); await first; await second; assert.equal(f.posts().length, 0);
});

// ---- Composer Playtest switch: automatic approval of the managed chat's requests ----
const AGENT_ACTOR = 'agent-' + 'f'.repeat(64);
function agentJob(id = 'job-1') { const value = job(id); value.actor = AGENT_ACTOR; return value; }

test('switch on: a managed chat request first seen while on is approved once, with the exact digest, and stays cancellable', async t => {
  let on = true;
  const f = fixture(t, [agentJob()], true, true, () => on);
  await f.panel.refresh(); assert.match(f.root.textContent, /Playtest is on · approving automatically/);
  t.mock.timers.tick(250); await flush();
  assert.equal(f.posts().length, 1);
  assert.equal(f.posts()[0]!.path, '/v1/playtests/approve');
  assert.deepEqual(f.posts()[0]!.body, { id: 'job-1', displayDigest: DIGEST }, 'same route and digest as the human click');
  assert.match(f.root.textContent, /Approved automatically · Playtest is on/);
  assert.equal(button(f, 'Stop').disabled, false, 'Stop stays available after automatic approval');
  for (let index = 0; index < 10; index++) { t.mock.timers.tick(250); await flush(); }
  assert.equal(f.posts().length, 1, 'never approved twice');
  on = false;
});

test('switch off: requests keep the human review and are never approved automatically', async t => {
  const f = fixture(t, [agentJob()], true, true, () => false);
  await f.panel.refresh();
  for (let index = 0; index < 20; index++) { t.mock.timers.tick(250); await flush(); }
  assert.equal(f.posts().length, 0); assert.doesNotMatch(f.root.textContent, /automatically/);
  assert.equal(button(f, 'Run test').disabled, false);
});

test('a request first seen while off is not approved when the switch turns on later', async t => {
  let on = false;
  const f = fixture(t, [agentJob()], true, true, () => on);
  await f.panel.refresh(); on = true;
  for (let index = 0; index < 20; index++) { t.mock.timers.tick(250); await flush(); }
  assert.equal(f.posts().length, 0, 'consent for an earlier request stays with the person');
});

test('switch on never approves a request made from this panel, an expired consent or one that needs review', async t => {
  const human = job('job-human'), expired = agentJob('job-expired'), review = agentJob('job-review');
  expired.display.consentExpiresAt = NOW - 1; review.review.requiresHumanReview = true;
  const f = fixture(t, [human, expired, review], true, true, () => true);
  await f.panel.refresh();
  for (let index = 0; index < 20; index++) { t.mock.timers.tick(250); await flush(); }
  assert.equal(f.posts().length, 0);
});

test('a throwing switch reads as off', async t => {
  const f = fixture(t, [agentJob()], true, true, () => { throw new Error('unavailable'); });
  await f.panel.refresh();
  for (let index = 0; index < 8; index++) { t.mock.timers.tick(250); await flush(); }
  assert.equal(f.posts().length, 0);
});

test('a FENCED status read shows Repair playtest records; two trusted clicks post the human repair and resume', async t => {
  const f = fixture(t, []);
  let fenced = true;
  f.handler(async call => {
    if (call.path === '/v1/playtests/repair') { fenced = false; return Response.json({ repaired: true, retained: 'playtests-retained/ledger-x', message: 'ok' }); }
    return fenced ? Response.json({ error: 'FENCED', message: 'paused' }, { status: 409 }) : Response.json({ jobs: [] });
  });
  await f.panel.refresh(); await f.panel.refresh(); await flush(); // the first call joins the mount-time read
  assert.equal(f.root.hidden, false, 'The fence is visible even with no jobs.');
  assert.match(f.root.textContent, /Playtests are paused/);
  const repair = button(f, 'Repair playtest records');
  repair.click(); await flush(); assert.equal(f.posts().length, 0, 'Untrusted clicks do nothing.');
  repair.emit('click', true); await flush();
  assert.equal(f.posts().length, 0, 'The first click only asks the person to confirm Studio is stopped.');
  assert.match(repair.textContent, /Studio is stopped/);
  repair.emit('click', true); await flush();
  assert.equal(f.posts().length, 1);
  assert.equal(f.posts()[0]!.path, '/v1/playtests/repair'); assert.deepEqual(f.posts()[0]!.body, { confirm: 'studio-in-edit-mode' });
  await flush();
  assert.match(f.root.textContent, /Playtest records repaired/);
  assert.equal(repair.hidden, true);
});

test('other refusals keep the generic refresh notice and never offer repair', async t => {
  const f = fixture(t, []);
  f.handler(async () => Response.json({ error: 'UNAVAILABLE', message: 'x' }, { status: 503 }));
  await f.panel.refresh(); await f.panel.refresh(); await flush();
  assert.match(f.root.textContent, /Couldn’t refresh test status/);
  const repair = f.root.all().find(element => element.tagName === 'BUTTON' && element.textContent === 'Repair playtest records');
  assert.ok(!repair || repair.hidden);
});
