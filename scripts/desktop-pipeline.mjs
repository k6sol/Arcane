import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readdir, writeFile, lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { packageWindows } from './package-windows.mjs';
import { checkWindowsExecutable } from './check-windows-executable.mjs';
const repository = resolve(fileURLToPath(new URL('..', import.meta.url)));
export async function buildDesktopPipeline() {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Desktop release automation needs Windows x64.');
  const root = join(repository,'runtime','verification'); await mkdir(root,{recursive:true});
  const directory = await mkdtemp(join(root,'desktop-pipeline-')), stages=[];
  const browserModule = join(repository,'node_modules','playwright-core','index.mjs');
  const browserExecutable = process.env.ARCANE_UI_BROWSER_EXE ?? join(process.env['ProgramFiles(x86)'] ?? 'C:/Program Files (x86)','Microsoft','Edge','Application','msedge.exe');
  for (const path of [browserModule,browserExecutable]) if (!(await lstat(path)).isFile()) throw new Error('Desktop release requires installed test-only Playwright and an explicit Chromium/Edge executable; checks cannot be silently skipped.');
  async function run(label,args) {
    console.log('Arcane verification: '+label);
    const started=Date.now(); let output='',bytes=0;
    const code=await new Promise((resolve,reject)=>{
      const env={...process.env}; delete env.ELECTRON_RUN_AS_NODE; env.ARCANE_UI_BROWSER_MODULE=browserModule; env.ARCANE_UI_BROWSER_EXE=browserExecutable;
      const child=spawn(process.execPath,args,{cwd:repository,env,shell:false,windowsHide:true,stdio:['ignore','pipe','pipe']});
      const capture=chunk=>{bytes+=chunk.length;if(bytes>16*1024*1024){child.kill();reject(new Error('Verification log limit exceeded.'));}else{output+=chunk.toString('utf8');}};
      child.stdout.on('data',capture);child.stderr.on('data',capture);
      const timeout=setTimeout(()=>{child.kill();reject(new Error('Verification stage deadline exceeded.'));},15*60*1000);
      child.once('error',()=>{clearTimeout(timeout);reject(new Error('Verification process could not start.'));});
      let drain; const terminal=code=>{clearTimeout(timeout);clearTimeout(drain);resolve(code??1);};
      child.once('close',terminal);
      child.once('exit',code=>{clearTimeout(timeout);drain=setTimeout(()=>{child.stdout.destroy();child.stderr.destroy();terminal(code);},250);});
    });
    await writeFile(join(directory,label+'.log'),output,{flag:'wx'});stages.push({label,code,elapsedMs:Date.now()-started});
    console.log(label+': exit '+code+'; '+(Date.now()-started)+'ms; log '+join(directory,label+'.log'));
    if(code!==0)throw new Error(label+' failed; retained logs: '+directory);
  }
  await run('compile',['scripts/compile-product.mjs']);
  await run('plugin-build',['scripts/build-plugin.mjs']);
  const unit=(await readdir(join(repository,'dist/tests/unit'))).filter(x=>/^[a-z0-9-]+\.test\.js$/.test(x)).sort().map(x=>join('dist/tests/unit',x));
  if(unit.length<10||unit.length>256)throw new Error('Unexpected unit verification inventory.');
  await run('unit-browser',['--test','--test-concurrency=1',...unit]);
  const offline=[];for(const category of ['skills','release','plugin'])for(const file of (await readdir(join(repository,'tests',category))).sort())if(/^[a-z0-9-]+\.test\.mjs$/.test(file))offline.push(join('tests',category,file));
  await run('offline-release-plugin',['--test','--test-concurrency=1',...offline]);
  const bundle=await packageWindows(); const executable=await checkWindowsExecutable(bundle.directory);
  const proof={schemaVersion:1,kind:'arcane-desktop-pipeline',stages,bundle,executable,automaticRetries:0,providerInference:false,studioOperations:0,fullProductVerified:false};
  await writeFile(join(directory,'pipeline.json'),JSON.stringify(proof,null,2)+'\n',{flag:'wx'});return {...proof,verificationDirectory:directory};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 if(process.argv.length!==2)throw new Error('Usage: node scripts/desktop-pipeline.mjs');
 console.log(JSON.stringify(await buildDesktopPipeline(),null,2));
}
