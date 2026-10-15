import test from 'node:test';
import assert from 'node:assert/strict';
import { scenarioRuntimeReportSchema,scenarioEvidenceIssue,scenarioPlanSchema } from '../../packages/studio-test-controller/src/scenario.js';
import { runScenarioFixture,fixtureScenario as keyboardScenario,fixtureLayoutScenario,type ScenarioFixtureOptions } from '../../packages/studio-test-controller/testing/scenario-fixture.js';

function clickScenario(){
  const plan=keyboardScenario();plan.targets.push({id:'button',root:'LocalPlayer.PlayerGui',segments:['Hud','Interact'],className:'TextButton'});
  plan.steps=[{id:'click',kind:'click-gui',targetId:'button'},plan.steps[3]!];return plan;
}
function attributeScenario(equals:boolean|number|string=2,requireTransition=true){
  return scenarioPlanSchema.parse({version:1,runtimeBudgetMs:300,targets:[],capture:{required:false},
    steps:[{id:'checkpoint',kind:'assert-player-attribute',attribute:'Checkpoint',equals,withinMs:100,requireTransition}]});
}
function verifyAttributeReport(plan:ReturnType<typeof attributeScenario>,options:ScenarioFixtureOptions){
  const actual=runScenarioFixture(plan,options);scenarioRuntimeReportSchema.parse(actual.report);
  assert.equal(scenarioEvidenceIssue(plan,actual.report.steps,actual.report.outcome==='passed',actual.report.inputRelease,actual.report.code),null);
  return actual;
}

for(const value of [false,0,'','Stage two', '雪🌳'])test('player attribute snapshots preserve the typed value '+JSON.stringify(value),()=>{
  const plan=attributeScenario(value,false),actual=verifyAttributeReport(plan,{attribute:{initial:value},inputUnavailable:true});
  assert.equal(actual.report.outcome,'passed');assert.equal(actual.inputRequests,0);assert.equal(actual.effects.length,0);
  assert.deepEqual(actual.report.steps[0]!.attribute,{context:'Client',subject:'LocalPlayer',name:'Checkpoint',
    baseline:{present:true,value},observed:{present:true,value}});
});

test('player attribute transition captures absence before interaction and the new checkpoint afterward',()=>{
  const plan=attributeScenario();plan.steps.unshift({id:'interact',kind:'hold-key',key:'E',holdMs:25});
  const actual=verifyAttributeReport(plan,{attribute:{next:2,transition:'input'}});
  assert.equal(actual.report.outcome,'passed');assert.equal(actual.report.inputRelease,'observed_released');
  assert.deepEqual(actual.report.steps[1]!.attribute,{context:'Client',subject:'LocalPlayer',name:'Checkpoint',baseline:{present:false},observed:{present:true,value:2}});
  assert.deepEqual(actual.effects.map(value=>[value.key,value.pressed]),[['E',true],['E',false]]);
});

test('read-only player attribute transition observes external state without requesting input',()=>{
  const actual=verifyAttributeReport(attributeScenario(),{attribute:{initial:1,next:2,transition:'wait'},inputUnavailable:true});
  assert.equal(actual.report.outcome,'passed');assert.equal(actual.inputRequests,0);assert.equal(actual.effects.length,0);
  assert.deepEqual(actual.report.steps[0]!.attribute?.baseline,{present:true,value:1});
});

test('missing or unchanged player attributes retain measured failure evidence and cannot impersonate false or zero',()=>{
  for(const value of [false,0,2]){
    const plan=attributeScenario(value,false),actual=verifyAttributeReport(plan,{});
    assert.equal(actual.report.code,'ASSERTION_FAILED');assert.equal(actual.report.steps[0]!.observed,false);
    assert.deepEqual(actual.report.steps[0]!.attribute?.observed,{present:false});assert.equal(actual.inputRequests,0);
  }
  const actual=verifyAttributeReport(attributeScenario(),{attribute:{initial:1}});
  assert.equal(actual.report.code,'ASSERTION_FAILED');assert.deepEqual(actual.report.steps[0]!.attribute?.observed,{present:true,value:1});
});

test('already satisfied player transition prevents an earlier input step and records its actual baseline',()=>{
  const plan=attributeScenario();plan.steps.unshift({id:'interact',kind:'hold-key',key:'E',holdMs:25});
  const actual=verifyAttributeReport(plan,{attribute:{initial:2}});
  assert.equal(actual.report.code,'ASSERTION_FAILED');assert.equal(actual.effects.length,0);
  assert.deepEqual(actual.report.steps[1]!.attribute?.baseline,{present:true,value:2});assert.equal(actual.report.steps[1]!.observed,false);
});

for(const invalid of ['table','nan','infinite','invalid-utf8','long-string','control']as const)test('unsupported player attribute '+invalid+' prevents the whole input plan',()=>{
  const plan=attributeScenario();plan.steps.unshift({id:'interact',kind:'hold-key',key:'E',holdMs:25});
  const actual=verifyAttributeReport(plan,{attribute:{invalid}});
  assert.equal(actual.report.code,'UNSUPPORTED_TOOL');assert.equal(actual.inputRequests,0);assert.equal(actual.effects.length,0);
  assert.ok(actual.report.steps.every(step=>step.outcome==='not_run'));
});

test('unavailable attribute APIs and read errors refuse without exposing exception content',()=>{
  for(const attribute of [{missingApi:true},{readError:true}]){
    const actual=verifyAttributeReport(attributeScenario(),{attribute});assert.equal(actual.report.code,'UNSUPPORTED_TOOL');
    assert.equal(actual.effects.length,0);assert.ok(!JSON.stringify(actual).includes('PRIVATE_ATTRIBUTE_ERROR'));
  }
});

for(const replace of ['player','character','gui']as const)test('player attribute wait keeps original '+replace+' identity',()=>{
  const actual=verifyAttributeReport(attributeScenario(),{replace,attribute:{initial:1,next:2,transition:'wait'}});
  assert.equal(actual.report.code,'BINDING_CHANGED');assert.equal(actual.report.outcome,'failed');assert.equal(actual.inputRequests,0);
});

test('player replacement inside attribute read is caught before its returned value becomes evidence',()=>{
  const actual=verifyAttributeReport(attributeScenario(2,false),{attribute:{initial:2,replaceOnRead:true}});
  assert.equal(actual.report.code,'BINDING_CHANGED');assert.equal(actual.report.steps[0]!.attribute,undefined);
});

test('player attribute evidence rejects borrowed names, authority, unmeasured failures and contradictory values',()=>{
  const plan=attributeScenario(),actual=verifyAttributeReport(plan,{attribute:{initial:1,next:2,transition:'wait'}});
  for(const mutate of [
    (row:typeof actual.report.steps[number])=>{row.attribute!.name='Foreign';},
    (row:typeof actual.report.steps[number])=>{row.attribute!.observed={present:false};},
    (row:typeof actual.report.steps[number])=>{row.attribute!.baseline={present:true,value:2};},
  ]){const rows=structuredClone(actual.report.steps);mutate(rows[0]!);assert.ok(scenarioEvidenceIssue(plan,rows,true,'not_started'));}
  const failure=structuredClone(actual.report.steps);failure[0]!.outcome='failed';failure[0]!.observed=false;delete failure[0]!.attribute;
  assert.ok(scenarioEvidenceIssue(plan,failure,false,'not_started','ASSERTION_FAILED'));
  for(const patch of [{context:'Server'},{subject:'AnotherPlayer'},{extra:'unapproved()'}]){
    const row=structuredClone(actual.report.steps[0]!);Object.assign(row.attribute!,patch);assert.equal(scenarioRuntimeReportSchema.safeParse({...actual.report,steps:[row]}).success,false);
  }
});

test('player attribute plans keep scope and bounds closed and quote attribute names as data',()=>{
  const plan=attributeScenario(),step=plan.steps[0]!;
  for(const patch of [{context:'Server'},{code:'unapproved()'},{targetId:'foreign'},{equals:null},{equals:{}},{equals:Infinity},{equals:1e16},
    {equals:'x'.repeat(129)},{equals:'雪'.repeat(100)},{equals:'\u0001'},{attribute:'\u202eForeign'},{withinMs:1001}]){
    assert.equal(scenarioPlanSchema.safeParse({...plan,steps:[{...step,...patch}]}).success,false);
  }
  const name='Checkpoint "];error("PRIVATE_INJECTION")--';Object.assign(step,{attribute:name});
  const actual=verifyAttributeReport(plan,{attribute:{name,initial:1,next:2,transition:'wait'}});assert.equal(actual.report.outcome,'passed');
  assert.equal(actual.report.steps[0]!.attribute!.name,name);
});

test('attribute type changes during a wait remain unsupported with no invented postcondition',()=>{
  const actual=verifyAttributeReport(attributeScenario(),{attribute:{initial:1,transition:'wait',invalid:'table',invalidAfterWait:true}});
  assert.equal(actual.report.code,'UNSUPPORTED_TOOL');assert.equal(actual.report.steps[0]!.observed,false);
  assert.deepEqual(actual.report.steps[0]!.attribute?.observed,{present:true,value:1});assert.equal(actual.effects.length,0);
});

test('production Luau scenario executes movement, ordinary interaction and measured transition assertions',()=>{
  const actual=runScenarioFixture(keyboardScenario());scenarioRuntimeReportSchema.parse(actual.report);
  assert.equal(actual.report.outcome,'passed');assert.equal(actual.report.inputRelease,'observed_released');assert.ok(Math.abs(Number(actual.report.steps[1]!.observed)-3.2)<1e-8);
  assert.equal(actual.report.steps[3]!.baseline,false);assert.equal(actual.report.steps[3]!.observed,true);
  assert.equal(actual.inputRequests,1);assert.equal(actual.creates,1);assert.equal(actual.held,false);assert.deepEqual(actual.effects.map(effect=>[effect.key,effect.pressed,effect.object]),[['W',true,1],['W',false,1],['E',true,1],['E',false,1]]);
});
for(const [name,options]of [['blocked movement',{immobile:true}],['interaction unchanged',{noInteraction:true}],['postcondition already satisfied',{alreadySatisfied:true}]]as const)test('production scenario fails '+name+' with actual step evidence',()=>{
  const actual=runScenarioFixture(keyboardScenario(),options);assert.equal(actual.report.outcome,'failed');assert.equal(actual.report.code,'ASSERTION_FAILED');assert.ok(actual.report.steps.some(step=>step.outcome==='failed'));assert.equal(actual.held,false);
  if(name==='postcondition already satisfied')assert.equal(actual.effects.length,0,'a preexisting postcondition is not interaction proof');
});
for(const replacement of ['character','gui','target']as const)test('private runtime references reject '+replacement+' replacement and release original input once',()=>{
  const actual=runScenarioFixture(keyboardScenario(),{replace:replacement});assert.equal(actual.report.outcome,'failed');assert.equal(actual.report.code,'BINDING_CHANGED');assert.equal(actual.creates,1);assert.equal(actual.held,false);
  assert.deepEqual(actual.effects.map(effect=>[effect.key,effect.pressed,effect.object]),[['W',true,1],['W',false,1]]);
  assert.equal(actual.report.inputRelease,replacement==='target'?'observed_released':'unknown');
});
test('press error after effect still releases through the original object, while release failure remains unknown',()=>{
  const pressed=runScenarioFixture(keyboardScenario(),{pressError:true});assert.equal(pressed.report.outcome,'unknown');assert.equal(pressed.report.inputRelease,'observed_released');assert.equal(pressed.held,false);assert.equal(pressed.effects.length,2);
  const release=runScenarioFixture(keyboardScenario(),{releaseError:true});assert.equal(release.report.inputRelease,'unknown');assert.equal(release.held,true);assert.equal(release.effects.filter(effect=>!effect.pressed).length,1);
});
test('unavailable input or preexisting focus never dispatches a press',()=>{
  for(const options of [{inputUnavailable:true},{focus:true}]){const actual=runScenarioFixture(keyboardScenario(),options);assert.equal(actual.report.outcome,'unsupported');assert.equal(actual.report.inputRelease,'not_started');assert.equal(actual.effects instanceof Array?actual.effects.length:Object.keys(actual.effects).length,0);}
});
test('read-only GUI snapshot assertions do not request virtual input even when it is unavailable',()=>{
  const plan=keyboardScenario();plan.capture.required=false;
  plan.steps=[{id:'hidden',kind:'assert-gui',targetId:'status',property:'Visible',equals:false,withinMs:100,requireTransition:false},
    {id:'closed',kind:'assert-text',targetId:'status',equals:'Closed',withinMs:100,requireTransition:false}];
  for(const inputUnavailable of [false,true]){
    const actual=runScenarioFixture(plan,{inputUnavailable});scenarioRuntimeReportSchema.parse(actual.report);
    assert.equal(actual.report.outcome,'passed');assert.equal(actual.report.inputRelease,'not_started');
    assert.equal(actual.inputRequests,0);assert.equal(actual.creates,0);assert.equal(actual.effects.length,0);assert.equal(actual.held,false);
    assert.equal(actual.report.steps[0]!.baseline,false);assert.equal(actual.report.steps[0]!.observed,false);
    assert.equal(actual.report.steps[1]!.baseline,'Closed');assert.equal(actual.report.steps[1]!.observed,'Closed');
  }
});

test('read-only assertions observe external transitions and displacement without injecting input',()=>{
  const plan=keyboardScenario();plan.capture.required=false;
  plan.steps=[plan.steps[3]!,{id:'text',kind:'assert-text',targetId:'status',equals:'Open',withinMs:100,requireTransition:true},
    {id:'distance',kind:'assert-displacement',minimumStuds:1}];
  const actual=runScenarioFixture(plan,{inputUnavailable:true,externalTransition:true});scenarioRuntimeReportSchema.parse(actual.report);
  assert.equal(actual.report.outcome,'passed');assert.equal(actual.report.inputRelease,'not_started');
  assert.equal(actual.inputRequests,0);assert.equal(actual.creates,0);assert.equal(actual.effects.length,0);
  assert.deepEqual(actual.report.steps.map(step=>[step.baseline,step.observed]),[[false,true],['Closed','Open'],[undefined,2]]);
});

test('read-only assertion failures retain measured evidence and transition policy without requiring input',()=>{
  const displacement=keyboardScenario();displacement.steps=[displacement.steps[1]!];
  const stationary=runScenarioFixture(displacement,{inputUnavailable:true});assert.equal(stationary.report.code,'ASSERTION_FAILED');
  assert.equal(stationary.report.steps[0]!.observed,0);assert.equal(stationary.report.steps[0]!.outcome,'failed');
  const transition=keyboardScenario();transition.steps=[transition.steps[3]!];
  const already=runScenarioFixture(transition,{inputUnavailable:true,alreadySatisfied:true});assert.equal(already.report.code,'ASSERTION_FAILED');
  assert.equal(already.report.steps[0]!.baseline,true);assert.equal(already.report.steps[0]!.observed,'already-satisfied');
  for(const actual of [stationary,already]){scenarioRuntimeReportSchema.parse(actual.report);assert.equal(actual.report.inputRelease,'not_started');assert.equal(actual.inputRequests,0);assert.equal(actual.creates,0);assert.equal(actual.effects.length,0);}
});

for(const replace of ['character','gui','target']as const)test('read-only assertions retain private '+replace+' identity while awaiting a transition',()=>{
  const plan=keyboardScenario();plan.steps=[plan.steps[3]!];
  const actual=runScenarioFixture(plan,{inputUnavailable:true,replace});scenarioRuntimeReportSchema.parse(actual.report);
  assert.equal(actual.report.code,'BINDING_CHANGED');assert.equal(actual.report.inputRelease,'not_started');
  assert.equal(actual.inputRequests,0);assert.equal(actual.creates,0);assert.equal(actual.effects.length,0);
});

test('production mouse input uses bound GUI identity and the same original release object after GUI replacement',()=>{
  const plan=clickScenario();
  const normal=runScenarioFixture(plan);assert.equal(normal.report.outcome,'passed');assert.equal(normal.inputRequests,1);assert.deepEqual(normal.effects.map(effect=>[effect.kind,effect.pressed,effect.object]),[['mouse',true,1],['mouse',false,1]]);
  assert.deepEqual(normal.effects.map(effect=>[effect.x,effect.y]),[[150,120],[150,120]],'the synthetic coincident basis sends and releases the same approved center');
  const replaced=runScenarioFixture(plan,{replace:'gui',replaceDuringMouse:true});assert.equal(replaced.report.code,'BINDING_CHANGED');assert.equal(replaced.report.inputRelease,'unknown');assert.equal(replaced.held,false);assert.equal(replaced.creates,1);assert.equal(replaced.effects.filter(effect=>!effect.pressed).length,1);
  const nested=runScenarioFixture(plan,{hit:'nested-button'});assert.equal(nested.report.code,'BINDING_CHANGED');assert.equal(nested.effects.length,0);
  const passive=runScenarioFixture(plan,{hit:'passive-label'});assert.equal(passive.report.outcome,'passed');
});

test('ambiguous or unavailable click coordinates refuse the whole plan before an earlier key press',()=>{
  const plan=clickScenario();plan.steps.unshift(keyboardScenario().steps[0]!);
  for(const basis of ['topbar','cutout','extent-mismatch','inset-only','missing-api','missing-inset','viewport-mismatch','nonfinite','oversized','zero-size','missing-camera']as const){
    const actual=runScenarioFixture(plan,{basis});scenarioRuntimeReportSchema.parse(actual.report);
    assert.equal(actual.report.code,'UNSUPPORTED_TOOL',basis);assert.equal(actual.report.outcome,'unsupported',basis);
    assert.equal(actual.report.inputRelease,'not_started',basis);assert.equal(actual.creates,0,basis);assert.equal(actual.effects.length,0,basis);
    assert.ok(actual.report.steps.every(step=>step.outcome==='not_run'),basis);
  }
});

for(const changeBasis of ['inset','viewport','camera']as const)test('retained click '+changeBasis+' is rechecked during an earlier held key',()=>{
  const plan=clickScenario();plan.steps.unshift(keyboardScenario().steps[0]!);
  const actual=runScenarioFixture(plan,{changeBasis});scenarioRuntimeReportSchema.parse(actual.report);
  assert.equal(actual.report.code,'BINDING_CHANGED');assert.equal(actual.report.inputRelease,'unknown');assert.equal(actual.held,false);assert.equal(actual.creates,1);
  assert.deepEqual(actual.effects.map(effect=>[effect.kind,effect.key,effect.pressed,effect.object]),[['key','W',true,1],['key','W',false,1]]);
  assert.equal(actual.report.steps[1]!.outcome,'not_run','changed coordinates never receive a click');
});

for(const changeBasis of ['inset','viewport','camera']as const)test('mouse release retains its original object and position after '+changeBasis+' changes',()=>{
  const actual=runScenarioFixture(clickScenario(),{changeBasis,changeDuringMouse:true});scenarioRuntimeReportSchema.parse(actual.report);
  assert.equal(actual.report.code,'BINDING_CHANGED');assert.equal(actual.report.inputRelease,'unknown');assert.equal(actual.held,false);assert.equal(actual.creates,1);
  assert.deepEqual(actual.effects.map(effect=>[effect.pressed,effect.object,effect.x,effect.y]),[[true,1,150,120],[false,1,150,120]]);
  assert.equal(actual.report.steps[1]!.outcome,'not_run','context loss cannot become an observed transition');
});

test('the click coordinate requirement does not acquire GUI services for a keyboard-only scenario',()=>{
  const actual=runScenarioFixture(keyboardScenario(),{basis:'missing-api'});assert.equal(actual.report.outcome,'passed');assert.equal(actual.report.inputRelease,'observed_released');
});

test('production layout snapshots use Core UI rectangles independently of camera viewport units',()=>{
  for(const layout of [{},{safeWidth:360,safeHeight:640,viewportWidth:390,viewportHeight:844,clipWidth:340,clipHeight:600},{clipping:false},{left:0.1,width:120,height:40}]){
    const plan=fixtureLayoutScenario(),actual=runScenarioFixture(plan,{layout,basis:'topbar',inputUnavailable:true});
    scenarioRuntimeReportSchema.parse(actual.report);assert.equal(scenarioEvidenceIssue(plan,actual.report.steps,true,'not_started',actual.report.code),null);
    assert.equal(actual.report.outcome,'passed');assert.equal(actual.inputRequests,0);assert.equal(actual.effects.length,0);
    const measured=actual.report.steps[0]!.layout!;assert.equal(measured.coordinateSpace,'CoreUISafeInsets');assert.equal(measured.viewport.units,'RobloxUIOffset');
    assert.ok(Array.isArray(measured.clips));assert.equal(actual.report.steps[0]!.observed,true);
  }
  const settling=runScenarioFixture(fixtureLayoutScenario(),{layout:{settle:true}});assert.equal(settling.report.outcome,'passed');assert.equal(settling.inputRequests,0);
});

for(const[name,layout]of [
  ['undersized',{width:119.999999}],['clipped',{left:350}],['outside safe area',{left:790,clipping:false}],['zero target',{width:0}],
  ['zero clipping area',{clipWidth:0}],['hidden target',{hiddenTarget:true}],['hidden ancestor',{hiddenAncestor:true}],['disabled ScreenGui',{disabledScreen:true}],
]as const)test('layout '+name+' has complete measured failure evidence',()=>{
  const plan=fixtureLayoutScenario(),actual=runScenarioFixture(plan,{layout,inputUnavailable:true});scenarioRuntimeReportSchema.parse(actual.report);
  assert.equal(actual.report.code,'ASSERTION_FAILED');assert.equal(actual.report.steps[0]!.observed,false);assert.ok(actual.report.steps[0]!.layout);
  assert.equal(scenarioEvidenceIssue(plan,actual.report.steps,false,'not_started',actual.report.code),null);
  assert.equal(actual.inputRequests,0);assert.equal(actual.effects.length,0);
});

test('unsupported layout geometry or APIs refuse a later layout before any earlier input acquisition',()=>{
  const plan=fixtureLayoutScenario();plan.steps.unshift({id:'earlier-key',kind:'hold-key',key:'W',holdMs:25});
  const variants:ScenarioFixtureOptions[]=[...(['target','ancestor','cancelled']as const).map(rotation=>({layout:{rotation}})),
    ...(['negative-size','nonfinite-position','negative-clip','oversized','safe-origin']as const).map(invalid=>({layout:{invalid}})),
    {layout:{folderParent:true}},{layout:{},basis:'missing-api'},{layout:{},basis:'missing-camera'},{layout:{},basis:'nonfinite'}];
  for(const options of variants){const actual=runScenarioFixture(plan,options);scenarioRuntimeReportSchema.parse(actual.report);
    assert.equal(actual.report.code,'UNSUPPORTED_TOOL',JSON.stringify(options));assert.equal(actual.inputRequests,0);assert.equal(actual.effects.length,0);
    assert.ok(actual.report.steps.every(row=>row.outcome==='not_run'));}
});

for(const changeBasis of ['safe-area','viewport','camera','service']as const)test('layout retains '+changeBasis+' context across a bounded wait',()=>{
  const plan=fixtureLayoutScenario(),actual=runScenarioFixture(plan,{layout:{width:1},changeBasis});scenarioRuntimeReportSchema.parse(actual.report);
  assert.equal(actual.report.code,'BINDING_CHANGED');assert.equal(actual.inputRequests,0);assert.equal(actual.effects.length,0);
  assert.equal(scenarioEvidenceIssue(plan,actual.report.steps,false,'not_started',actual.report.code),null);
});
for(const replace of ['layout-target','layout-ancestor']as const)test('layout keeps exact '+replace+' identity rather than reacquiring its selector',()=>{
  const actual=runScenarioFixture(fixtureLayoutScenario(),{layout:{width:1},replace});assert.equal(actual.report.code,'BINDING_CHANGED');assert.equal(actual.inputRequests,0);assert.equal(actual.effects.length,0);
});
test('layout selector ambiguity cannot gain input authority and mixed plans acquire input exactly once',()=>{
  const plan=fixtureLayoutScenario();plan.steps.unshift({id:'walk',kind:'hold-key',key:'W',holdMs:25});
  const duplicate=runScenarioFixture(plan,{layout:{duplicateTarget:true}});assert.equal(duplicate.report.code,'BINDING_CHANGED');assert.equal(duplicate.inputRequests,0);
  const actual=runScenarioFixture(plan,{layout:{}});assert.equal(actual.report.outcome,'passed');assert.equal(actual.inputRequests,1);assert.equal(actual.creates,1);
  assert.deepEqual(actual.effects.map(row=>[row.pressed,row.object]),[[true,1],[false,1]]);
  const changed=runScenarioFixture(plan,{layout:{},changeBasis:'safe-area'});assert.equal(changed.report.code,'BINDING_CHANGED');assert.equal(changed.report.inputRelease,'unknown');assert.equal(changed.held,false);
  assert.deepEqual(changed.effects.map(row=>[row.pressed,row.object]),[[true,1],[false,1]]);
});
test('layout step retains the closed selectors, finite dimensions and total wait budget',()=>{
  for(const patch of [{minimumWidth:0},{minimumHeight:4097},{minimumWidth:1.5},{withinMs:1001},{requireTransition:true},{code:'unapproved()'}]){
    const plan=fixtureLayoutScenario();Object.assign(plan.steps[0]!,patch);assert.equal(scenarioPlanSchema.safeParse(plan).success,false);
  }
  const plan=fixtureLayoutScenario();plan.runtimeBudgetMs=100;Object.assign(plan.steps[0]!,{withinMs:101});assert.equal(scenarioPlanSchema.safeParse(plan).success,false);
});
test('layout supports a retained Folder prefix before its ScreenGui without crossing a GUI clipping container',()=>{
  const plan=fixtureLayoutScenario();plan.targets[0]!.segments.unshift('Ui');
  const actual=runScenarioFixture(plan,{layout:{folderBeforeScreen:true}});scenarioRuntimeReportSchema.parse(actual.report);
  assert.equal(actual.report.outcome,'passed');assert.equal(actual.inputRequests,0);assert.equal(actual.effects.length,0);
  assert.equal(scenarioEvidenceIssue(plan,actual.report.steps,true,'not_started',actual.report.code),null);
});
