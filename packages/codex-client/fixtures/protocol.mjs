// Synthetic protocol peer: spawned Node, no Codex and no inference.
import { createInterface } from 'node:readline';
import { appendFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
const [mode, audit] = process.argv.slice(2);
let initialized = false, turnNumber = 0, deferredTurnAck = null;
const threadId = 'fixture-thread';
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const notify = (method, params) => send({ method, params });
const record = value => appendFileSync(audit, JSON.stringify(value) + '\n');
record({ type: 'spawn', cwd: process.cwd(), envKeys: Object.keys(process.env), argv: process.argv.slice(4),
  arcaneDaemonUrl: process.env.ARCANE_DAEMON_URL ?? null,
  arcaneTokenSha256: process.env.ARCANE_LOCAL_TOKEN ? createHash('sha256').update(process.env.ARCANE_LOCAL_TOKEN).digest('hex') : null });
const model = (name = 'fixture-sol') => ({ id: 'picker-' + name, model: name, displayName: name, hidden: false,
  supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'ultra' }], defaultReasoningEffort: 'low',
  email: 'synthetic@example.test', accessToken: 'FIXTURE_SECRET' });
const split = async value => {
  const bytes = Buffer.from(JSON.stringify(value) + '\n');
  for (let i=0;i<bytes.length;i++) { process.stdout.write(bytes.subarray(i,i+1)); await new Promise(resolve => setImmediate(resolve)); }
};
const turn = (id, status = 'inProgress') => ({ id, status, items: [], error: null });
const approval = (id, kind = 'command', extra = {}) => {
  if (kind === 'file' && mode !== 'missing-file-preview') notify('item/started', {threadId,turnId:'fixture-turn-'+turnNumber,item:{id:'fixture-item-file-'+id,type:'fileChange',status:'inProgress',changes:[{path:mode==='outside-file-preview'?'../outside.txt':mode==='oversized-file-preview'?'large.txt':'review.txt',kind:{type:'update',move_path:null},diff:mode==='oversized-file-preview'?'x'.repeat(65537):'@@ fixture diff @@\n+reviewed'}]}});
  send({
  id, method: kind === 'file' ? 'item/fileChange/requestApproval' : 'item/commandExecution/requestApproval',
  params: { threadId, turnId: 'fixture-turn-' + turnNumber, itemId: 'fixture-item-' + kind + '-' + id,
    ...(kind === 'file' ? {} : { command: 'fixture test command', cwd: process.cwd(), kind: 'command', environmentId: null }),
    reason: 'Synthetic approval', ...extra },
  });
};
createInterface({ input: process.stdin }).on('line', line => {
  let message; try { message=JSON.parse(line); } catch { process.exit(9); }
  record({ type: 'input', message });
  if (!message.method) {
    notify('serverRequest/resolved', { threadId, requestId: message.id });
    if (deferredTurnAck && message.id === 701) approval(702);
    else if (deferredTurnAck && message.id === 702) {
      send({ id: deferredTurnAck.id, result: { turn: turn(deferredTurnAck.turnId) } });
      deferredTurnAck = null;
    }
    return;
  }
  const { id, method, params = {} } = message;
  if (method === 'initialize') {
    if (params.capabilities?.experimentalApi !== false) process.exit(8);
    if(mode!=='image-history-resume')send({ id: 999999, result: { ignored: true } });
    send({ id, result: { userAgent: 'fixture', platformFamily: 'windows', platformOs: 'windows' } }); return;
  }
  if (method === 'initialized') { initialized = true; return; }
  if (!initialized) { send({ id, error: { code: -32000, message: 'FIXTURE_SECRET not initialized' } }); return; }
  if (method === 'account/read') {
    if (mode === 'malformed-response') { send({id,error:null}); return; }
    setTimeout(() => send({ id, result: {
      account: mode === 'api-account' ? { type: 'apiKey' } : { type: 'chatgpt', planType: 'pro', email: 'synthetic@example.test', accessToken: 'FIXTURE_SECRET' },
      requiresOpenaiAuth: true, accessToken: 'FIXTURE_SECRET',
    } }), 35); return;
  }
  if (method === 'account/rateLimits/read') {
    const rateLimits={limitId:'codex',limitName:'Codex fixture',primary:{usedPercent:25,windowDurationMins:300,resetsAt:1792104000},secondary:null,credits:{hasCredits:true,unlimited:false,balance:'FIXTURE_SECRET'},rateLimitReachedType:null};
    setTimeout(()=>send({id,result:{ordinaryUsageAllowed:true,rateLimits,rateLimitsByLimitId:{codex:rateLimits},accountId:'FIXTURE_SECRET',rateLimitResetCredits:{credits:[{id:'FIXTURE_SECRET'}]}}}),mode==='quota-held'?300:2);return;
  }
  if (method === 'model/list') {
    const first = !params.cursor;
    let data = first ? [model(), { hidden: true, accessToken: 'FIXTURE_SECRET' }] : [model('fixture-other')];
    if(mode==='image-input'||mode==='image-text-only')data=data.map(item=>({...item,inputModalities:mode==='image-input'?['text','image']:['text']}));
    if (mode === 'duplicate-model' && !first) data = [model()];
    if (mode === 'duplicate-effort') data = [{ ...model(), supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'low' }] }];
    setTimeout(() => send({ id, result: { data, nextCursor: mode === 'cursor-loop' ? 'page-two' : first ? 'page-two' : null } }), 2); return;
  }
  if (method === 'mcpServerStatus/list') { send({id,result:{data:[...(mode==='inherited-mcp-active'?[{name:'unsafe-inherited',runtimeStatus:'connected',tools:{write:{}},toolsError:null,pluginId:null}]:[]),{name:'arcane',runtimeStatus:mode==='bad-mcp-inventory'?'unsafe':'connected',tools:Object.fromEntries(["sessions","scene_children","scene_inspect","scene_search","selection_read","script_read","script_search","script_update","script_set_enabled","scene_create","scene_update","receipt_status","receipt_restore","playtest_request","playtest_status","playtest_cancel","skills_recommend","skills_list","skills_get","work_runs","work_ready","work_create","work_claim","work_progress","work_submit","assets_probe","assets_jobs","assets_start","assets_cancel","assets_manifest"].filter(name=>mode!=='missing-script-search'||name!=='script_search').map(name=>[name,{description:'FIXTURE_SECRET'}])),toolsError:null,pluginId:null,accessToken:'FIXTURE_SECRET'}],nextCursor:mode==='mcp-cursor-loop'?'same':null}});return; }
  if(method==='thread/read'&&mode==='image-history-resume'){
    // Metadata-only reads (includeTurns:false) carry no turns, as in the public schema.
    const thread={id:params.threadId,sessionId:'fixture-session-root',cwd:process.cwd(),ephemeral:false};
    if(params.includeTurns===true)thread.turns=JSON.parse(readFileSync(join(dirname(audit),'image-history.json'),'utf8'));
    send({id,result:{thread}});return;
  }
  if (method === 'thread/start' || method === 'thread/resume') {
    if (mode === 'reject-thread') { send({ id, error: { code: -32001, message: 'FIXTURE_SECRET rejected' } }); return; }
    if (mode === 'malformed-thread-ack-no-id') { send({ id, result: {} }); return; }
    const effectiveId = mode === 'wrong-resume-id' ? 'wrong-fixture-thread' : params.threadId ?? threadId;
    notify('thread/started', { thread: { id: effectiveId, sessionId: 'fixture-session-root' } });
    if (mode === 'lost-thread-ack') return;
    if (mode === 'malformed-thread-ack-observed') { send({ id, result: {} }); return; }
    let turns=mode==='resume-unexpected-active'?[turn('existing-active-turn')]:[];
    if(method==='thread/resume'&&mode==='image-history-resume'){
      const history=JSON.parse(readFileSync(join(dirname(audit),'image-history.json'),'utf8'));
      record({type:'image-history',historyBytes:Buffer.byteLength(JSON.stringify({id,result:{thread:{id:effectiveId,turns:history}}})),excluded:params.excludeTurns===true});
      if(params.excludeTurns!==true)turns=history;
    }
    send({ id, result: {
      thread: { id: mode === 'malformed-thread-id' ? null : effectiveId, sessionId: 'fixture-session-root', status: { type: ['resume-active-unknown','resume-unexpected-active'].includes(mode) ? 'active' : 'idle' }, turns },
      model: mode === 'bad-model' ? 'fixture-fallback' : params.model, modelProvider: 'openai', cwd: process.cwd(),
      approvalPolicy: 'on-request', approvalsReviewer: mode === 'bad-reviewer' ? 'auto_review' : 'user',
      sandbox: mode === 'malformed-thread-sandbox' ? null : { type: mode === 'bad-sandbox' ? 'workspaceWrite' : 'readOnly', networkAccess: false },
      reasoningEffort: 'low', path: 'FIXTURE_SECRET',
    } }); return;
  }
  if (method === 'turn/start') {
    const turnId = 'fixture-turn-' + (++turnNumber);
    if(mode==='image-input')notify('item/started',{threadId,turnId,item:{id:'synthetic-image-input',type:'userMessage',content:params.input}});
    if (mode === 'lost-turn-no-id' || mode === 'revoke-start-no-id') return;
    if (mode === 'malformed-turn-ack-no-id') { send({ id, result: {} }); return; }
    if (mode === 'malformed-turn-id') { send({ id, result: { turn: turn(null) } }); return; }
    if (mode === 'approval-before-turn-id' || (mode.startsWith('stale-approval-before-turn-id-') && turnNumber > 1)) {
      // The test releases the ACK by answering a fresh approval. No timer decides this race.
      deferredTurnAck = { id, turnId };
      if (mode === 'approval-before-turn-id') approval(702);
      else approval(701, mode.endsWith('-file') ? 'file' : 'command', { turnId: 'fixture-turn-1' });
      return;
    }
    notify('turn/started', { threadId, turn: turn(turnId) });
    if (mode === 'lost-turn-ack') return;
    if (mode === 'terminal-before-lost-ack') { notify('turn/completed', { threadId, turn: turn(turnId, 'completed') }); return; }
    if (mode === 'malformed-turn-ack-observed') { send({ id, result: {} }); return; }
    if (mode === 'malformed-turn-status') { send({ id, result: { turn: turn(turnId, null) } }); return; }
    if (mode === 'disconnect-turn') { setTimeout(() => process.exit(0), 20); return; }
    if (mode === 'reject-turn') { send({ id, error: { code: -32002, message: 'FIXTURE_SECRET rejected' } }); return; }
    if (mode === 'stale-turn-event' && turnNumber > 1) {
      notify('turn/started', {threadId,turn:turn('fixture-turn-1')});
      notify('turn/completed', {threadId,turn:turn('fixture-turn-1','completed')});
    }
    if ((mode === 'stale-turn-event' || mode.startsWith('stale-approval-before-turn-id-')) && turnNumber === 1) notify('turn/completed',{threadId,turn:turn(turnId,'completed')});
    if (mode === 'complete-before-ack'||mode==='image-history-resume') notify('turn/completed', { threadId, turn: turn(turnId, 'completed') });
    send({ id, result: { turn: turn(turnId) } });
    if (mode === 'split-utf8') { void split({ method: 'item/agentMessage/delta', params: { threadId, turnId, itemId: 'fixture-message', delta: 'héllo 🌕' } }); return; }
    if (mode === 'malformed') { process.stdout.write('{"not JSON"\n'); return; }
    if (mode === 'bad-utf8') { process.stdout.write(Buffer.from([0x7b,0x22,0xff,0x22,0x7d,10])); return; }
    if (mode === 'oversized-frame') { process.stdout.write('x'.repeat(5000)); return; }
    if (mode === 'stderr-flood') { process.stderr.write('FIXTURE_SECRET'.repeat(100)); return; }
    if (mode === 'output-flood') { for(let n=0;n<300;n++) notify('unhandled/notification',{data:'x'.repeat(100)}); return; }
    if (mode === 'identical-deltas' || mode === 'event-gaps') {
      const delta = text => notify('item/agentMessage/delta',{threadId,turnId,itemId:'fixture-message',delta:text});
      delta('same');
      if (mode === 'event-gaps') delta('x'.repeat(2000)); else delta('same');
      delta('same');
      if (mode === 'event-gaps') delta('x'.repeat(2000));
      return;
    }
    if (mode === 'event-flood') {
      for(let n=0;n<40;n++) notify('item/agentMessage/delta',{threadId,turnId,itemId:'fixture-message',delta:'delta-'+n});
      notify('account/chatgptAuthTokens/changed',{accessToken:'FIXTURE_SECRET',email:'synthetic@example.test'}); return;
    }
    if (mode === 'account-change') { notify('account/updated',{authMode:'apikey',accessToken:'FIXTURE_SECRET'}); return; }
    if (mode === 'resolved-approval') { approval(7); setTimeout(()=>notify('serverRequest/resolved',{threadId,requestId:7}),150); return; }
    if (mode === 'disconnect-approval') { approval(7); setTimeout(()=>process.exit(0),250); return; }
    if (mode === 'duplicate-server-id') { approval(7); approval(7); return; }
    if (mode === 'approval-limit') { approval(7); approval(8); return; }
    if (mode === 'unsupported-request') {
      for(const name of ['account/chatgptAuthTokens/refresh','attestation/generate','item/permissions/requestApproval','item/tool/call','mcpServer/elicitation/request'])
        send({id:'unsupported-'+name,method:name,params:{accessToken:'FIXTURE_SECRET',threadId,turnId}});
      return;
    }
    if (['completed-file-item','changed-file-item'].includes(mode)) {
      approval('file','file');
      setTimeout(()=>notify(mode==='completed-file-item'?'item/completed':'item/started',{threadId,turnId,item:{id:'fixture-item-file-file',type:'fileChange',status:mode==='completed-file-item'?'declined':'inProgress',changes:[{path:'review.txt',kind:{type:'update',move_path:null},diff:'replacement fixture diff'}]}}),150);
      return;
    }
    if (['missing-file-preview','outside-file-preview','oversized-file-preview'].includes(mode)) { approval('file','file'); return; }
    if (mode === 'foreign-approval') { approval(7,'command',{threadId:'another-thread'}); return; }
    if (mode === 'unsafe-approval') { approval(7,'command',{networkApprovalContext:{host:'example.test',protocol:'https'}}); approval(8,'file',{grantRoot:process.cwd()}); return; }
    if (['approvals','late-approval','approval-expiry'].includes(mode)) { approval(7); if(mode==='approvals') approval('7','file'); }
    return;
  }
  if (method === 'turn/interrupt') {
    if (mode === 'lost-interrupt-ack') return;
    send({id,result:{}});
    if (mode === 'late-approval') approval(90);
    setTimeout(()=>{
      notify('turn/completed',{threadId,turn:turn(params.turnId,'interrupted')});
      if(mode==='late-approval') approval(91);
    },10); return;
  }
  send({id,error:{code:-32601,message:'Unknown method'}});
});
