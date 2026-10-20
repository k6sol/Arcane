import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,realpathSync,writeFileSync,lstatSync,rmSync} from 'node:fs';
import {join,relative,isAbsolute,sep} from 'node:path';
import {tmpdir} from 'node:os';
import {createConnectionLab} from '../../apps/daemon/src/lab-server.js';
import {refuseNativeCodex,noProviderProbe} from './native-fixture-refusal.js';
import {StudioStore} from '../../packages/storage/src/studio-store.js';

test('the product serves both shared conversation modules without connecting a provider', {timeout:15000},async t=>{
  const boundary=realpathSync.native(tmpdir()),root=realpathSync.native(mkdtempSync(join(boundary,'arcane-shared-routes-'))),project=join(root,'project');mkdirSync(project);
  const output=join(root,'dist/apps/desktop/src');mkdirSync(output,{recursive:true});
  const payloads=new Map([['conversation-library.js','export const sharedLibraryFixture = true;'],['shared-conversations.js','import "./conversation-library.js"; export const sharedControllerFixture = true;']]);
  for(const [file,body]of payloads)writeFileSync(join(output,file),body);
  const studio=new StudioStore({directory:join(root,'studio-metadata')});let lab:Awaited<ReturnType<typeof createConnectionLab>>|null=null;
  t.after(async()=>{await lab?.close();studio.close();const part=relative(boundary,root);assert.ok(part.startsWith('arcane-shared-routes-')&&!isAbsolute(part)&&!part.includes(sep));assert.equal(lstatSync(root).isSymbolicLink(),false);rmSync(root,{recursive:true,force:true});});
  // A local metadata store enables the product renderer; no Studio session is paired or contacted.
  lab=await createConnectionLab({cwd:root,projectPath:project,stateDirectory:join(root,'state'),studioStore:studio,probe:noProviderProbe,codexConnect:refuseNativeCodex});
  for(const [file,body]of payloads){const response:Response=await fetch(lab.origin+'/'+file);assert.equal(response.status,200);assert.match(response.headers.get('content-type')??'',/javascript/);assert.equal(await response.text(),body);}
});
