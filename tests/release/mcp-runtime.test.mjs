import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { checkMcpRuntime } from '../../scripts/check-mcp-runtime.mjs';
import policy from '../../apps/desktop/electron/policy.cjs';

async function directory(t) {
  const path = await mkdtemp(join(tmpdir(), 'arcane-mcp-runtime-'));
  t.after(() => rm(path, { recursive: true, force: true })); return path;
}
function environment(directory) {
  return policy.daemonEnvironment(process.env, { productRoot: directory, stateRoot: join(directory, 'state'), projectPath: directory });
}
const guidance = { tool: 'skills_recommend', selection: 'deterministic-task-relevance', approvalChanged: false,
  available: true, ids: ['arcane-test'], context: 'Fixture guidance', bytes: 16 };
async function fixture(t, behavior) {
  const project = await directory(t), entry = join(project, 'dist/apps/mcp/src/main.js');
  await mkdir(dirname(entry), { recursive: true });
  // This child speaks actual newline-delimited MCP and terminates only on stdin
  // EOF; failures exercise the verifier's live process/protocol boundaries.
  await writeFile(entry, `const readline=require('node:readline');
const behavior=${JSON.stringify(behavior)}, guidance=${JSON.stringify(guidance)};
const send=(id,result)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\\n');
const lines=readline.createInterface({input:process.stdin});
lines.on('line',line=>{const q=JSON.parse(line);if(q.id===1)send(behavior==='wrong-id'?8:1,{protocolVersion:q.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'arcane-studio',version:'fixture'}});
if(q.id===2){if(behavior==='hang'){setInterval(()=>{},10000);return;}if(behavior==='oversize'){process.stdout.write('x'.repeat(600000));return;}
send(2,{tools:behavior==='duplicate-tools'?[{name:'skills_recommend',inputSchema:{type:'object'}},{name:'skills_recommend',inputSchema:{type:'object'}}]:[{name:'skills_recommend',inputSchema:{type:'object'}}]});}
if(q.id===3){if(behavior==='daemon-request')fetch(process.env.ARCANE_DAEMON_URL).then(()=>{});if(behavior==='bad-guidance')guidance.bytes++;
if(behavior==='bad-id')guidance.ids=[null];if(behavior==='duplicate-ids')guidance.ids=['arcane-test','arcane-test'];if(behavior==='blank-context'){guidance.context='   ';guidance.bytes=3;}
send(3,{content:[{type:'text',text:JSON.stringify(guidance)}],structuredContent:guidance});if(behavior==='trailing-output')process.stdout.write('unfinished');}
});lines.on('close',()=>{if(behavior==='nonzero')process.exitCode=7;if(behavior==='stderr')process.stderr.write('fixture diagnostic');if(behavior==='hang-close')setInterval(()=>{},10000);});
`);
  return { nodeExecutable: process.execPath, productRoot: project, workingDirectory: project, env: environment(project), expectedTools: ['skills_recommend'] };
}

test('MCP acceptance retains an acknowledged successful process exit', async t => {
  assert.equal((await checkMcpRuntime(await fixture(t, 'normal'))).code, 0);
});
for (const behavior of ['wrong-id', 'duplicate-tools', 'oversize', 'bad-guidance', 'bad-id', 'duplicate-ids', 'blank-context', 'trailing-output', 'nonzero', 'stderr']) {
  test('MCP acceptance rejects ' + behavior + ' and observes owned process termination', async t => {
    await assert.rejects(checkMcpRuntime(await fixture(t, behavior)), /Process exit acknowledged/);
  });
}
test('MCP acceptance detects even a passive unexpected daemon request', async t => {
  await assert.rejects(checkMcpRuntime(await fixture(t, 'daemon-request')), /attempted a daemon request/);
});
test('MCP acceptance bounds a live request that stops responding', async t => {
  await assert.rejects(checkMcpRuntime(await fixture(t, 'hang')), /deadline exceeded.*Process exit acknowledged/);
});
test('MCP acceptance requires actual child exit after the final response', async t => {
  await assert.rejects(checkMcpRuntime(await fixture(t, 'hang-close')), /deadline exceeded.*Process exit acknowledged/);
});
test('MCP acceptance rejects invalid paths and inventories before process creation', async () => {
  await assert.rejects(checkMcpRuntime({ nodeExecutable: 'relative', productRoot: process.cwd(), workingDirectory: process.cwd(), expectedTools: ['skills_recommend'] }), /Invalid fixed/);
  await assert.rejects(checkMcpRuntime({ nodeExecutable: process.execPath, productRoot: process.cwd(), workingDirectory: process.cwd(), expectedTools: ['skills_recommend', 'skills_recommend'] }), /Invalid fixed/);
  await assert.rejects(checkMcpRuntime({ nodeExecutable: process.execPath, productRoot: process.cwd(), workingDirectory: process.cwd(), expectedTools: ['skills_recommend', 'sessions\n'] }), /Invalid fixed/);
});
