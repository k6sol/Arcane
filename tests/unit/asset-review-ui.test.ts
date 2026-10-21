import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { AssetReviewApi, AssetReviewCard, AssetReviewRequestError, readAssetReviewStatus, installAssetReviewSelection } from '../../apps/desktop/src/asset-review.js';
import { LearningDocument, learningTick } from './learning-ui-fixture.js';
const JOB = '11111111-1111-4111-8111-111111111111', REVIEW = '22222222-2222-4222-8222-222222222222';
const WITNESS = '88888888-8888-4888-8888-888888888888';
const KEY = '33333333-3333-4333-8333-333333333333', TOKEN = 'a'.repeat(64), ORIGIN = 'http://127.0.0.1:32123';
const viewed = { jobId: JOB, sha256: 'd'.repeat(64), bytes: 256 };
const canonical = (value: any): string => Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']' : value && typeof value === 'object' ?
  '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}' : JSON.stringify(value);
function status(change: (subject: any) => void = () => {}) {
  const subject: any = { schemaVersion: 1, projectId: 'b'.repeat(64), conversation: { provider: 'codex', threadId: 'owned-thread', sessionId: null },
    jobId: JOB, manifestSha256: 'c'.repeat(64), sourceRequestSha256: 'e'.repeat(64),
    artifacts: [{ path: 'asset.glb', sha256: viewed.sha256, bytes: 256 }, { path: 'collision.glb', sha256: 'f'.repeat(64), bytes: 128 }] };
  change(subject);
  const subjectDigest = createHash('sha256').update(canonical(subject)).digest('hex');
  const review = { reviewId: REVIEW, subject, subjectDigest, status: 'pending', revision: 0, preparedAt: '2026-10-19T00:00:00.000Z', decidedAt: null };
  return { subject, subjectDigest, review, openWitness: WITNESS, retry: false };
}

test('recorded model decisions emit the exact verified job; mismatched receipts emit no learning event', async t => {
  for (const decision of ['approved', 'rejected', 'mismatched'] as const) await t.test(decision, async t => {
    const doc = new LearningDocument(ORIGIN), signals: unknown[] = [];
    doc.addEventListener('arcane-learning-signal', event => signals.push((event as CustomEvent).detail));
    const card = new AssetReviewCard(doc.asDocument(), TOKEN, { tokenOrigin: ORIGIN, transport: async (path, init) => {
      if (String(path).endsWith('/prepare')) return Response.json(status());
      const command = JSON.parse(String(init!.body)), next = status();
      Object.assign(next.review, { status: command.decision, revision: 1, decidedAt: '2026-10-19T00:01:00Z' });
      if (decision === 'mismatched') next.review.subject.jobId = REVIEW;
      return Response.json({ state: 'recorded', review: next.review, command: { idempotencyKey: command.idempotencyKey, decision: command.decision, revision: 1 }, retry: false });
    } });
    t.after(() => card.clear());
    await card.show(doc.root as unknown as HTMLElement, viewed, new AbortController().signal, () => true);
    const button = doc.root.querySelectorAll('button').find(node => node.textContent === (decision === 'rejected' ? 'Reject model' : 'Approve model'))!;
    assert.equal(button.disabled, false); button.trustedClick();
    const deadline = Date.now() + 2000;
    while (!/Model approved\.|Model rejected\.|Decision not confirmed\./.test(doc.root.textContent) && Date.now() < deadline) await learningTick();
    assert.deepEqual(signals, decision === 'mismatched' ? [] : [{ source: 'review', jobId: JOB, positive: decision === 'approved' }]);
    assert.match(doc.root.textContent, decision === 'mismatched' ? /Decision not confirmed/ : /Model (?:approved|rejected)/);
  });
});
test('review subject is bound to the viewed render bytes and canonical host digest', async () => {
  const good = await readAssetReviewStatus(status(), viewed); assert.equal(good.review!.status, 'pending');
  for (const mutate of [
    (s: any) => { s.jobId = REVIEW; }, (s: any) => { s.artifacts[0].sha256 = '0'.repeat(64); },
    (s: any) => { s.artifacts[0].bytes++; }, (s: any) => { s.artifacts.reverse(); },
    (s: any) => { s.conversation.provider = 'native-agent'; }, (s: any) => { s.target = 'Studio'; },
  ]) await assert.rejects(readAssetReviewStatus(status(mutate), viewed));
  const altered = status(); altered.subjectDigest = '0'.repeat(64); await assert.rejects(readAssetReviewStatus(altered, viewed));
  const mismatched = status(); mismatched.review.subject = status(s => { s.artifacts[1].sha256 = '0'.repeat(64); }).subject;
  await assert.rejects(readAssetReviewStatus(mismatched, viewed));
});
test('pending and decided review revisions and exact response shapes are validated', async () => {
  for (const change of [
    (s: any) => { s.retry = true; }, (s: any) => { s.review.revision = 1; },
    (s: any) => { s.review.status = 'approved'; }, (s: any) => { s.review.decidedAt = '2026-10-19T00:00:00Z'; },
    (s: any) => { s.review.reviewId = '../review'; }, (s: any) => { s.review.raw = '<script>'; },
  ]) { const s: any = status(); change(s); await assert.rejects(readAssetReviewStatus(s, viewed)); }
  const approved: any = status(); Object.assign(approved.review, { status: 'approved', revision: 1, decidedAt: '2026-10-19T00:01:00Z' });
  assert.equal((await readAssetReviewStatus(approved, viewed)).review!.status, 'approved');
});
test('human transport is POST-only, token-origin bound, bounded and cache-free', async () => {
  const calls: { path: string; init: RequestInit }[] = [];
  const api = new AssetReviewApi(TOKEN, ORIGIN, () => ORIGIN, async (path, init) => { calls.push({ path: String(path), init: init! }); return Response.json(status()); });
  await api.request('prepare', { jobId: JOB }, new AbortController().signal);
  const request = calls[0]!; assert.equal(request.path, '/v1/assets/review/prepare'); assert.equal(request.init.method, 'POST');
  assert.deepEqual(JSON.parse(String(request.init.body)), { jobId: JOB });
  assert.deepEqual(request.init.headers, { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' });
  assert.equal(request.init.cache, 'no-store'); assert.equal(request.init.credentials, 'omit'); assert.equal(request.init.redirect, 'error'); assert.equal(request.init.referrerPolicy, 'no-referrer');
  let attempts = 0; const transport: typeof fetch = async () => { attempts++; return Response.json(status()); };
  await assert.rejects(new AssetReviewApi(TOKEN, ORIGIN, () => 'http://127.0.0.1:9', transport).request('prepare', { jobId: JOB }, new AbortController().signal));
  await assert.rejects(new AssetReviewApi('invalid', ORIGIN, () => ORIGIN, transport).request('prepare', { jobId: JOB }, new AbortController().signal));
  assert.equal(attempts, 0);
});
test('unknown decision acknowledgements are classified without any transport replay', async () => {
  for (const make of [
    () => Promise.reject(new TypeError('PRIVATE_NETWORK_SENTINEL')),
    () => Promise.resolve(Response.json({ state: 'unknown', retry: false }, { status: 202 })),
    () => Promise.resolve(new Response('PRIVATE_HTML_SENTINEL', { headers: { 'Content-Type': 'text/html' } })),
    () => Promise.resolve(new Response('broken json', { headers: { 'Content-Type': 'application/json' } })),
    () => Promise.resolve(new Response('{}', { headers: { 'Content-Type': 'application/json', 'Content-Length': '999999' } })),
  ]) {
    let calls = 0; const api = new AssetReviewApi(TOKEN, ORIGIN, () => ORIGIN, async () => { calls++; return make(); });
    await assert.rejects(api.request('decide', { reviewId: REVIEW, decision: 'approved', idempotencyKey: KEY, openWitness: WITNESS }, new AbortController().signal),
      (e: unknown) => e instanceof AssetReviewRequestError && e.unknownOutcome && !/PRIVATE/.test(e.message));
    assert.equal(calls, 1);
  }
});
test('client decision and observation routes reject caller hashes, targets and extra fields before dispatch', async () => {
  let calls = 0;
  const api = new AssetReviewApi(TOKEN, ORIGIN, () => ORIGIN, async () => { calls++; return Response.json({}); });
  for (const body of [
    { reviewId: REVIEW, decision: 'approved', idempotencyKey: KEY, openWitness: WITNESS, sha256: viewed.sha256 },
    { reviewId: REVIEW, decision: 'approved', idempotencyKey: KEY, openWitness: WITNESS, target: 'Studio' },
    { jobId: JOB }, { reviewId: REVIEW, decision: 'approve', idempotencyKey: KEY, openWitness: WITNESS },
  ]) await assert.rejects(api.request('decide', body as any, new AbortController().signal));
  await assert.rejects(api.request('../start' as any, { jobId: JOB }, new AbortController().signal));
  await assert.rejects(api.request('status', { jobId: JOB, subjectDigest: viewed.sha256 } as any, new AbortController().signal));
  assert.equal(calls, 0);
});
test('decision timeout aborts the original request, and receipt/status reads never replay it', async () => {
  let signal: AbortSignal | undefined, calls = 0;
  const api = new AssetReviewApi(TOKEN, ORIGIN, () => ORIGIN, async (_path, init) => { calls++; signal = init!.signal!; return new Promise<Response>(() => {}); }, 10);
  await assert.rejects(api.request('decide', { reviewId: REVIEW, decision: 'rejected', idempotencyKey: KEY, openWitness: WITNESS }, new AbortController().signal),
    (e: unknown) => e instanceof AssetReviewRequestError && e.unknownOutcome);
  assert.equal(signal!.aborted, true); assert.equal(calls, 1);
  const seen: string[] = [], reads = new AssetReviewApi(TOKEN, ORIGIN, () => ORIGIN, async (path, init) => { seen.push(String(path)); assert.equal(init!.method, 'POST'); return Response.json({}); });
  await reads.request('receipt', { reviewId: REVIEW, idempotencyKey: KEY }, new AbortController().signal);
  await reads.request('status', { jobId: JOB }, new AbortController().signal);
  assert.deepEqual(seen, ['/v1/assets/review/receipt', '/v1/assets/review/status']);
});

test('review open witnesses are exact server values and status alone cannot enable decisions', async t => {
  for (const openWitness of [undefined, '', '../open', 'a'.repeat(64), 1]) {
    await assert.rejects(readAssetReviewStatus({ ...status(), openWitness }, viewed));
  }
  const observation = { ...status(), openWitness: null };
  assert.equal((await readAssetReviewStatus(observation, viewed)).openWitness, null);
  await assert.rejects(readAssetReviewStatus({ ...status(), review: null }, viewed));
  const doc = new LearningDocument(ORIGIN), calls: string[] = [];
  const card = new AssetReviewCard(doc.asDocument(), TOKEN, { tokenOrigin: ORIGIN, transport: async path => {
    calls.push(String(path)); return Response.json(observation);
  } });
  t.after(() => card.clear());
  await card.show(doc.root as unknown as HTMLElement, viewed, new AbortController().signal, () => true);
  for (const label of ['Approve model', 'Reject model']) {
    const button = doc.root.querySelectorAll('button').find(node => node.textContent === label)!;
    assert.equal(button.disabled, true); button.trustedClick();
  }
  assert.deepEqual(calls, ['/v1/assets/review/prepare']);
});

test('review waits for the current parent selection and drops a held opening on chat change', { timeout: 5000 }, async t => {
  const doc = new LearningDocument(ORIGIN), calls: string[] = [];
  let release!: (lease: () => boolean) => void, invalidate: (() => void) | null = null, live = true;
  const ready = new Promise<() => boolean>(resolve => { release = resolve; });
  const unbind = installAssetReviewSelection(doc.asDocument(), { ready: () => ready, subscribeInvalidate: listener => {
    invalidate = listener; return () => { invalidate = null; };
  } });
  const card = new AssetReviewCard(doc.asDocument(), TOKEN, { tokenOrigin: ORIGIN, transport: async path => {
    calls.push(String(path)); return Response.json(status());
  } });
  t.after(() => { card.clear(); unbind(); });
  const opening = card.show(doc.root as unknown as HTMLElement, viewed, new AbortController().signal, () => true);
  assert.deepEqual(calls, []); assert.equal(doc.root.querySelectorAll('button')[0]!.disabled, true);
  live = false; (invalidate as (() => void) | null)?.(); release(() => live); await opening;
  assert.deepEqual(calls, [], 'obsolete selection never prepares a model review');
  assert.equal(doc.root.querySelectorAll('button').length, 0, 'old review controls are removed synchronously');
});

test('review checks selection again after a held prepare before enabling any decision', { timeout: 5000 }, async t => {
  const doc = new LearningDocument(ORIGIN), calls: string[] = [];
  let release!: (response: Response) => void, started!: () => void, invalidate: (() => void) | null = null, live = true;
  const admitted = new Promise<void>(resolve => { started = resolve; });
  const unbind = installAssetReviewSelection(doc.asDocument(), { ready: async () => () => live, subscribeInvalidate: listener => {
    invalidate = listener; return () => { invalidate = null; };
  } });
  const card = new AssetReviewCard(doc.asDocument(), TOKEN, { tokenOrigin: ORIGIN, transport: async path => {
    calls.push(String(path)); started(); return new Promise<Response>(resolve => { release = resolve; });
  } });
  t.after(() => { card.clear(); unbind(); });
  const opening = card.show(doc.root as unknown as HTMLElement, viewed, new AbortController().signal, () => true);
  await admitted; live = false; (invalidate as (() => void) | null)?.(); release(Response.json(status())); await opening;
  assert.deepEqual(calls, ['/v1/assets/review/prepare']);
  assert.equal(doc.root.querySelectorAll('button').length, 0);
});

test('a status refresh preserves only the same opening and approved models remain rejectable', async t => {
  const doc = new LearningDocument(ORIGIN), calls: { path: string; body: any }[] = [];
  let approved = false;
  const card = new AssetReviewCard(doc.asDocument(), TOKEN, { tokenOrigin: ORIGIN, transport: async (path, init) => {
    const body = JSON.parse(String(init!.body)); calls.push({ path: String(path), body });
    const value = status();
    if (approved) Object.assign(value.review, { status: 'approved', revision: 1, decidedAt: '2026-10-19T00:01:00Z' });
    if (String(path).endsWith('/status')) return Response.json({ ...value, openWitness: null });
    if (String(path).endsWith('/decide')) {
      assert.deepEqual(Object.keys(body).sort(), ['decision', 'idempotencyKey', 'openWitness', 'reviewId']);
      assert.equal(body.openWitness, WITNESS);
      approved = body.decision === 'approved';
      Object.assign(value.review, { status: body.decision, revision: approved ? 1 : 2, decidedAt: '2026-10-19T00:02:00Z' });
      return Response.json({ state: 'recorded', review: value.review, command: { idempotencyKey: body.idempotencyKey, decision: body.decision, revision: value.review.revision }, retry: false });
    }
    return Response.json(value);
  } });
  t.after(() => card.clear());
  await card.show(doc.root as unknown as HTMLElement, viewed, new AbortController().signal, () => true);
  const button = (label: string) => doc.root.querySelectorAll('button').find(node => node.textContent === label)!;
  button('Approve model').trustedClick();
  for (let n = 0; n < 100 && !/Model approved\./.test(doc.root.textContent); n++) await learningTick();
  assert.match(doc.root.textContent, /Model approved\./);
  button('Refresh review').trustedClick();
  for (let n = 0; n < 100 && !/Review status refreshed\./.test(doc.root.textContent); n++) await learningTick();
  assert.equal(button('Reject model').disabled, false);
  button('Reject model').trustedClick();
  for (let n = 0; n < 100 && !/Model rejected\./.test(doc.root.textContent); n++) await learningTick();
  assert.match(doc.root.textContent, /Model rejected\./);
  assert.deepEqual(calls.filter(c => c.path.endsWith('/decide')).map(c => c.body.decision), ['approved', 'rejected']);
});

function providerStatus(provider:'codex'|'claude-code'|'arcane') {
  return status(subject=>{subject.conversation={provider,threadId:provider==='codex'?'owned-thread':'app:'+JOB,sessionId:null};});
}
for(const provider of ['codex','claude-code','arcane'] as const)test(provider+' review status preserves actual attribution and refuses mismatched provider, digest and viewed bytes',async()=>{
  for(const decision of ['pending','approved','rejected'] as const){
    const value=providerStatus(provider);
    if(decision!=='pending')Object.assign(value.review,{status:decision,revision:1,decidedAt:'2026-10-19T00:01:00Z'});
    const measured=await readAssetReviewStatus(value,viewed);
    assert.deepEqual(measured.subject.conversation,value.subject.conversation);
    assert.deepEqual(measured.review!.subject.conversation,value.subject.conversation);
    assert.equal(measured.review!.status,decision);
  }
  const other=provider==='arcane'?'claude-code':'arcane';
  const wrongProvider=providerStatus(provider);wrongProvider.review.subject=structuredClone(wrongProvider.subject);wrongProvider.review.subject.conversation.provider=other;
  await assert.rejects(readAssetReviewStatus(wrongProvider,viewed));
  const wrongDigest=providerStatus(provider);wrongDigest.review.subjectDigest='0'.repeat(64);
  await assert.rejects(readAssetReviewStatus(wrongDigest,viewed));
  const wrongBytes=providerStatus(provider);wrongBytes.review.subject=structuredClone(wrongBytes.subject);wrongBytes.review.subject.artifacts[0].bytes++;
  await assert.rejects(readAssetReviewStatus(wrongBytes,viewed));
  const badViewed=providerStatus(provider);await assert.rejects(readAssetReviewStatus(badViewed,{...viewed,bytes:viewed.bytes+1}));
});

for(const provider of ['codex','claude-code','arcane'] as const)test(provider+' review card requires a trusted human decision and fences mismatched receipts',async t=>{
  for(const outcome of ['approved','rejected','provider-mismatch','digest-mismatch','bytes-mismatch'] as const)await t.test(outcome,async t=>{
    const doc=new LearningDocument(ORIGIN),signals:unknown[]=[],calls:string[]=[];
    doc.addEventListener('arcane-learning-signal',event=>signals.push((event as CustomEvent).detail));
    const card=new AssetReviewCard(doc.asDocument(),TOKEN,{tokenOrigin:ORIGIN,transport:async(path,init)=>{
      calls.push(String(path));if(String(path).endsWith('/prepare'))return Response.json(providerStatus(provider));
      assert.equal(String(path),'/v1/assets/review/decide');
      const command=JSON.parse(String(init!.body)),next=providerStatus(provider);
      assert.deepEqual(Object.keys(command).sort(),['decision','idempotencyKey','openWitness','reviewId']);
      assert.equal(command.openWitness,WITNESS);
      Object.assign(next.review,{status:command.decision,revision:1,decidedAt:'2026-10-19T00:01:00Z'});
      if(outcome==='provider-mismatch')next.review.subject.conversation.provider=provider==='arcane'?'claude-code':'arcane';
      if(outcome==='digest-mismatch')next.review.subjectDigest='0'.repeat(64);
      if(outcome==='bytes-mismatch')next.review.subject.artifacts[0].bytes++;
      return Response.json({state:'recorded',review:next.review,command:{idempotencyKey:command.idempotencyKey,decision:command.decision,revision:1},retry:false});
    }});
    t.after(()=>card.clear());
    await card.show(doc.root as unknown as HTMLElement,viewed,new AbortController().signal,()=>true);
    assert.deepEqual(calls,['/v1/assets/review/prepare']);assert.deepEqual(signals,[]);
    assert.match(doc.root.textContent,/Pending/);
    const button=doc.root.querySelectorAll('button').find(node=>node.textContent===(outcome==='rejected'?'Reject model':'Approve model'))!;
    assert.equal(button.disabled,false);button.dispatchEvent(new Event('click'));await learningTick();
    assert.deepEqual(calls,['/v1/assets/review/prepare'],'untrusted clicks never submit decisions');
    button.trustedClick();const deadline=Date.now()+2000;
    while(!/Model approved\.|Model rejected\.|Decision not confirmed\./.test(doc.root.textContent)&&Date.now()<deadline)await learningTick();
    const accepted=outcome==='approved'||outcome==='rejected';
    assert.deepEqual(signals,accepted?[{source:'review',jobId:JOB,positive:outcome==='approved'}]:[]);
    assert.match(doc.root.textContent,accepted?/Model (?:approved|rejected)/:/Decision not confirmed/);
    assert.deepEqual(calls,['/v1/assets/review/prepare','/v1/assets/review/decide'],'no automatic approval or decision replay');
    if(!accepted)assert.equal(button.disabled,true,'unconfirmed decisions remain fenced');
  });
});
