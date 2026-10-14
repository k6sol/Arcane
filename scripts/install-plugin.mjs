import {mkdir,readFile,writeFile,stat,lstat,realpath,rename,copyFile} from 'node:fs/promises';
import {resolve,join,dirname,relative,isAbsolute,sep} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const repo=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const hash=b=>createHash('sha256').update(b).digest('hex');
function inside(root,p){const d=relative(root,p);return d===''||(!isAbsolute(d)&&d!=='..'&&!d.startsWith('..'+sep));}
async function noLinks(p){let x=resolve(p);for(;;){try{if((await lstat(x)).isSymbolicLink())throw new Error('Link/junction not permitted in install path.');}catch(e){if(e.code!=='ENOENT')throw e;}let parent=dirname(x);if(parent===x)return;x=parent;}}
export async function installPlugin({localAppData=process.env.LOCALAPPDATA,installDirectory,repository=repo}={}){
 if(process.platform!=='win32'&&!installDirectory)throw new Error('This installer currently supports Windows. Use the documented manual install on other systems.');
 if(!localAppData&&!installDirectory)throw new Error('LOCALAPPDATA is unavailable.');
 const build=join(repository,'plugin','build');const manifest=JSON.parse(await readFile(join(build,'manifest.json'),'utf8'));
 if(manifest.schemaVersion!==1||manifest.protocolVersion!==1||manifest.entry!=='ArcaneLocalBridge')throw new Error('Unrecognized plugin manifest.');
 for(const source of manifest.sources){if(!/^src\/[A-Za-z][A-Za-z0-9]*(?:\.server)?\.luau$/.test(source.path))throw new Error('Invalid manifest source path.');const bytes=await readFile(join(repository,'plugin',source.path));const normalized=Buffer.from(bytes.toString('utf8').replace(/^\uFEFF/,'').replace(/\r\n?/g,'\n'));if(hash(normalized)!==source.sha256)throw new Error('Build is stale; rebuild the plugin first.');}
 const filename=manifest.preferredArtifact; if(filename!=='ArcaneLocalBridge.lua')throw new Error('Expected the reviewed native Lua bundle.');
 const artifact=manifest.artifacts.find(a=>a.name===filename);const bytes=await readFile(join(build,filename));
 if(!artifact||hash(bytes)!==artifact.sha256||bytes.length!==artifact.bytes||!bytes.toString('utf8').startsWith('--!strict')||!bytes.toString('utf8').includes('local __arcaneFactories'))throw new Error('Plugin artifact checksum failed.');
 const root=resolve(installDirectory??join(localAppData,'Roblox','Plugins'));await noLinks(root);await mkdir(root,{recursive:true});if(await realpath(root)!==root)throw new Error('Install directory resolves to a different location.');
 const backupRoot=join(repository,'runtime','plugin-backups');await noLinks(backupRoot);await mkdir(backupRoot,{recursive:true});
 const migrated=[];for(const oldName of ['ArcaneLocalBridge.rbxm','ArcaneLocalBridge.rbxmx']){const oldPath=join(root,oldName);await noLinks(oldPath);try{const old=await readFile(oldPath);if(!old.toString('utf8').includes('<string name="Name">ArcaneLocalBridge</string>'))throw new Error('Refusing to move an unrelated plugin.');const backup=join(backupRoot,randomUUID()+'.'+oldName);if(!inside(repository,backup))throw new Error('Backup escapes repository');await rename(oldPath,backup);migrated.push({from:oldPath,backup,sha256:hash(old)});}catch(e){if(e.code!=='ENOENT')throw e;}}
 const target=join(root,filename);await noLinks(target);let backup=null;
 try{const old=await readFile(target);if(hash(old)===hash(bytes))return{installed:true,changed:false,target,sha256:hash(bytes),backup:null,migrated,studioReloadRequired:true};
  if(!old.toString('utf8').includes('local __arcaneFactories'))throw new Error('A different plugin occupies this name; refusing to overwrite.');
  const backupRoot=join(repository,'runtime','plugin-backups');await noLinks(backupRoot);await mkdir(backupRoot,{recursive:true});backup=join(backupRoot,randomUUID()+'.rbxm');if(!inside(repository,backup))throw new Error('Backup escapes workspace.');await writeFile(backup,old,{flag:'wx'});
 }catch(e){if(e.code!=='ENOENT')throw e;}
 const temp=join(root,'ArcaneLocalBridge.'+randomUUID()+'.partial');await writeFile(temp,bytes,{flag:'wx'});await rename(temp,target);
 if(hash(await readFile(target))!==hash(bytes))throw new Error('Installed plugin checksum mismatch. Backup retained.');
 return{installed:true,changed:true,target,sha256:hash(bytes),backup,migrated,studioReloadRequired:true};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 if(process.argv.length!==2)throw new Error('No arbitrary install flags are accepted.');
 console.log(JSON.stringify(await installPlugin(),null,2));
}
