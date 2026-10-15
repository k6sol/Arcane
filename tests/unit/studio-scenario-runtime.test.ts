import test from 'node:test';
import assert from 'node:assert/strict';
import { scenarioRuntimeReportSchema } from '../../packages/studio-test-controller/src/scenario.js';
import { runScenarioFixture,fixtureScenario as keyboardScenario } from '../../packages/studio-test-controller/testing/scenario-fixture.js';

function clickScenario(){
  const plan=keyboardScenario();plan.targets.push({id:'button',root:'LocalPlayer.PlayerGui',segments:['Hud','Interact'],className:'TextButton'});
  plan.steps=[{id:'click',kind:'click-gui',targetId:'button'},plan.steps[3]!];return plan;
}

test('production Luau scenario executes movement, ordinary interaction and measured transition assertions',()=>{
  const actual=runScenarioFixture(keyboardScenario());scenarioRuntimeReportSchema.parse(actual.report);
  assert.equal(actual.report.outcome,'passed');assert.equal(actual.report.inputRelease,'observed_released');assert.ok(Math.abs(Number(actual.report.steps[1]!.observed)-3.2)<1e-8);
  assert.equal(actual.report.steps[3]!.baseline,false);assert.equal(actual.report.steps[3]!.observed,true);
  assert.equal(actual.creates,1);assert.equal(actual.held,false);assert.deepEqual(actual.effects.map(effect=>[effect.key,effect.pressed,effect.object]),[['W',true,1],['W',false,1],['E',true,1],['E',false,1]]);
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
test('production mouse input uses bound GUI identity and the same original release object after GUI replacement',()=>{
  const plan=clickScenario();
  const normal=runScenarioFixture(plan);assert.equal(normal.report.outcome,'passed');assert.deepEqual(normal.effects.map(effect=>[effect.kind,effect.pressed,effect.object]),[['mouse',true,1],['mouse',false,1]]);
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
