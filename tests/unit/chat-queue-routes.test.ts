import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,realpathSync,writeFileSync,lstatSync,rmSync} from 'node:fs';
import {join,relative,isAbsolute,sep} from 'node:path';
import {tmpdir} from 'node:os';
import {createConnectionLab} from '../../apps/daemon/src/lab-server.js';
import {refuseNativeCodex,noProviderProbe} from './native-fixture-refusal.js';
import {StudioStore} from '../../packages/storage/src/studio-store.js';

test('the queue schema module is served by the actual product route without provider or Studio connections',{timeout:15000},async t=>{
  const boundary=realpathSync.native(tmpdir()),root=realpathSync.native(mkdtempSync(join(boundary,'arcane-queue-route-'))),project=join(root,'project');mkdirSync(project);
  const output=join(root,'dist/packages/protocol/src');mkdirSync(output,{recursive:true});
  const body='export const queueRouteFixture = true;';writeFileSync(join(output,'chat-queue.js'),body);
  const studio=new StudioStore({directory:join(root,'metadata')});let lab:Awaited<ReturnType<typeof createConnectionLab>>|null=null;
  t.after(async()=>{await lab?.close();studio.close();const part=relative(boundary,root);assert.ok(part.startsWith('arcane-queue-route-')&&!isAbsolute(part)&&!part.includes(sep));assert.equal(lstatSync(root).isSymbolicLink(),false);rmSync(root,{recursive:true,force:true});});
  lab=await createConnectionLab({cwd:root,projectPath:project,stateDirectory:join(root,'state'),studioStore:studio,probe:noProviderProbe,codexConnect:refuseNativeCodex});
  const response=await fetch(lab.origin+'/packages/protocol/src/chat-queue.js');assert.equal(response.status,200);assert.match(response.headers.get('content-type')??'',/javascript/);assert.equal(await response.text(),body);
  const missing=await fetch(lab.origin+'/packages/protocol/src/not-allowed.js');assert.notEqual(missing.status,200,'the module route does not expose arbitrary protocol files');
});
