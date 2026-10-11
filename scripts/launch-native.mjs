import { resolve, join, dirname } from 'node:path';
import { realpath, access, mkdtemp, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { generateConfig } from '../apps/mcp/scripts/generate-config.mjs';
const repo=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const {discoverProviders}=await import('../dist/packages/model-adapters/src/discovery.js');
const {locateNativeCli}=await import('../dist/packages/model-adapters/src/process.js');
const {nativeLaunchPlan}=await import('../dist/packages/model-adapters/src/native-launch.js');
const {SelectionStore}=await import('../dist/packages/core/src/selection.js');
const {validateDaemonUrl}=await import('../dist/apps/mcp/src/daemon-client.js');
const project=await realpath(process.env.ARCANE_PROJECT??repo);
const dry=process.argv.slice(2).includes('--dry-run');
if(process.argv.slice(2).some(v=>v!=='--dry-run'))throw new Error('Only --dry-run is supported. Choose model/effort in the provider panel first.');
const saved=await new SelectionStore(join(repo,'runtime','connection-lab')).read();
if(!saved)throw new Error('Choose an exact native provider/model/effort in Arcane first.');
if(!dry){validateDaemonUrl(process.env.ARCANE_DAEMON_URL);if(!/^[a-f0-9]{64}$/.test(process.env.ARCANE_LOCAL_TOKEN??''))throw new Error('Set the local launcher token in ARCANE_LOCAL_TOKEN, not a provider credential.');}
const connections=await discoverProviders(project);const current=connections.find(c=>c.provider===saved.provider);
if(!current||current.auth!=='subscription'||current.warnings.some(w=>w.includes('environment overrides are present')))throw new Error('Native subscription/authentication route could not be confirmed. No API/cloud fallback attempted.');
const command=await locateNativeCli(saved.provider);if(!command)throw new Error('Native client is not installed.');
let config;
if(saved.provider==='claude'){
 const configRoot=join(repo,'apps','mcp','generated');await import('node:fs/promises').then(fs=>fs.mkdir(configRoot,{recursive:true}));
 const dir=await mkdtemp(join(configRoot,'native-'));const relative=dir.slice(repo.length+1);
 config=(await generateConfig({projectRoot:repo,outputDirectory:relative})).files.find(p=>p.endsWith('claude.mcp.json'));
}
const plan=nativeLaunchPlan({...saved,connectionRevision:current.revision},connections,{executable:command,projectPath:project,arcanePath:repo,nodePath:process.execPath,...(config?{claudeConfigPath:config}:{})});
await access(join(repo,'dist','apps','mcp','src','main.js'));
console.log(JSON.stringify(plan,null,2));
if(!dry){
 if(!process.stdin.isTTY||!process.stdout.isTTY)throw new Error('Open this command in your own interactive terminal. Arcane does not run a hidden subscription inference proxy.');
 const child=spawn(plan.command,plan.args,{cwd:project,env:process.env,stdio:'inherit',shell:false,windowsHide:false});
 child.once('error',()=>{console.error('Native client could not start; no fallback run attempted.');process.exitCode=1;});
 child.once('close',(code)=>{process.exitCode=code??1;});
}
