import test from 'node:test';
import assert from 'node:assert/strict';
import {createModelSourceConsent,type ModelSourceContext} from '../../apps/desktop/src/toolbox-policy.js';

const source=(fingerprint='original typed brief'):ModelSourceContext=>({provider:'codex',projectPath:'C:\\Project',localId:'draft-original',fingerprint});
function fixture(){
  let context:ModelSourceContext|null=source(),session='studio-a';
  const consent=createModelSourceConsent({context:()=>context,session:()=>session});
  return {consent,set:(value:ModelSourceContext|null)=>{context=value;},session:(value:string)=>{session=value;},arm:()=>{assert.equal(consent.arm(true),true);consent.confirm(true);}};
}
test('Models consent requires an explicit trusted gesture and a confirmed exact message, never a manual status read',()=>{
  const f=fixture();f.consent.confirm(true);assert.equal(f.consent.port.capture(),null);
  assert.equal(f.consent.arm(false),false);assert.equal(f.consent.pending(),false);
  assert.equal(f.consent.arm(true),true);assert.throws(()=>f.consent.port.capture(),/Wait for the Models setting/);
  f.consent.confirm(true);const ticket=f.consent.port.capture()!;assert.equal(f.consent.pending(),false);
  const admitted=ticket.consume()!;assert.deepEqual(admitted.scope,{sessionId:'studio-a'});assert.equal(admitted.current(),true);
  assert.equal(ticket.consume(),null);f.consent.confirm(true);assert.equal(f.consent.port.capture(),null,'a poll cannot re-arm the next message');
});
for(const changed of [null,{...source(),provider:'claude' as const},{...source(),projectPath:'C:\\Other'},{...source(),localId:'draft-other'},source('edited brief or model or attachment revision')]){
  test('Models consent refuses a changed original message context: '+JSON.stringify(changed),()=>{
    const f=fixture();f.arm();const ticket=f.consent.port.capture()!;f.set(changed);assert.equal(ticket.consume(),null);
    f.set(source());assert.equal(f.consent.port.capture(),null,'old consent is not available for another Send');
  });
}
test('Models session selection and explicit revocation fence captured tickets including A to B to A',()=>{
  const f=fixture();f.arm();const ticket=f.consent.port.capture()!;
  f.session('studio-b');f.consent.invalidate();f.session('studio-a');assert.equal(ticket.consume(),null);
  f.arm();const admitted=f.consent.port.capture()!.consume()!;assert.equal(admitted.current(),true);f.consent.port.invalidate();assert.equal(admitted.current(),false);
});
test('Models gesture snapshots its context and rejected or unobserved confirmation cannot create another ticket',()=>{
  const f=fixture(),mutable=source();f.set(mutable);assert.equal(f.consent.arm(true),true);
  (mutable as {fingerprint:string}).fingerprint='changed after gesture';f.consent.confirm(true);assert.equal(f.consent.pending(),false);
  f.set(source());f.arm();f.consent.confirm(false);assert.equal(f.consent.port.capture(),null);
  f.set(null);assert.equal(f.consent.arm(true),false);f.consent.confirm(true);assert.equal(f.consent.port.capture(),null);
});
test('Models native session field rejects malformed or control-suffixed values without changing message ownership',()=>{
  for(const session of ['', 'a\n','studio a','x'.repeat(129)]){const f=fixture();f.session(session);assert.equal(f.consent.arm(true),false);assert.equal(f.consent.port.capture(),null);}
});
