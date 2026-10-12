/** Compile all actual product files, including Windows cloud placeholders. */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, relative, isAbsolute, sep } from 'node:path';
import { lstat, realpath, readdir, readFile, mkdir, open, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

const SOURCE_PATTERNS = new Map([
  ['apps/daemon/src/**/*.ts', 'apps/daemon/src'],
  ['apps/desktop/src/**/*.ts', 'apps/desktop/src'],
  ['apps/mcp/src/**/*.ts', 'apps/mcp/src'],
  ['packages/**/*.ts', 'packages'],
  ['tests/unit/**/*.ts', 'tests/unit'],
]);
const within = (root, target) => { const p=relative(root,target);return p==='' || (!isAbsolute(p)&&p!=='..'&&!p.startsWith('..'+sep)); };
async function regularPath(root, target) {
  const s=await lstat(target),actual=await realpath(target);
  if(s.isSymbolicLink()||!within(root,actual)||resolve(target).toLowerCase()!==actual.toLowerCase())throw new Error('Compiler paths cannot redirect outside the source checkout.');
  return s;
}

export async function explicitProjectConfig(root) {
  root=await realpath(resolve(root));
  const config=JSON.parse(await readFile(join(root,'tsconfig.json'),'utf8'));
  if(!Array.isArray(config.include)||!config.include.length||config.include.some(p=>!SOURCE_PATTERNS.has(p))||new Set(config.include).size!==config.include.length)throw new Error('Unsupported source include patterns. Review tsconfig.json before building.');
  const files=[];
  async function walk(directory) {
    const stat=await regularPath(root,directory);if(!stat.isDirectory())throw new Error('Expected a product source directory.');
    for(const entry of await readdir(directory,{withFileTypes:true})) {
      if(entry.name.startsWith('.')||['node_modules','runtime','dist','generated'].includes(entry.name))continue;
      const target=join(directory,entry.name),kind=await regularPath(root,target);
      // Node lstat is authoritative. Go's glob incorrectly skips some genuine
      // OneDrive ReparsePoint files; explicit files are not lost to that glob.
      if(kind.isDirectory())await walk(target);
      else if(kind.isFile()&&entry.name.endsWith('.ts')) {
        if(kind.size>4*1024*1024||files.length>=4096)throw new Error('Compiler source budget exceeded.');
        files.push(target);
      }
    }
  }
  for(const pattern of config.include)await walk(join(root,SOURCE_PATTERNS.get(pattern)));
  files.sort();if(!files.length)throw new Error('No product sources found.');
  return {extends:join(root,'tsconfig.json'),include:[],exclude:[],files};
}

const here=fileURLToPath(import.meta.url);
if(process.argv[1]&&resolve(process.argv[1])===here) {
  const args=process.argv.slice(2);
  if(args.length>1||(args.length===1&&args[0]!=='--noEmit')) {console.error('Usage: node scripts/compile-product.mjs [--noEmit]');process.exitCode=2;}
  else {
    let configPath,owned=false;
    try {
      const root=await realpath(dirname(dirname(here)));
      const config=await explicitProjectConfig(root);
      const runtime=join(root,'runtime');await mkdir(runtime,{recursive:true});await regularPath(root,runtime);
      const directory=join(runtime,'build');await mkdir(directory,{recursive:true});await regularPath(root,directory);
      configPath=join(directory,'compile-'+randomUUID()+'.json');
      const handle=await open(configPath,'wx',0o600);owned=true;
      try{await handle.writeFile(JSON.stringify(config));await handle.sync();}finally{await handle.close();}
      const env={...process.env};
      if(process.platform==='win32'){env.GOMAXPROCS??='1';env.GOMEMLIMIT??='256MiB';}
      const child=spawn(process.execPath,[join(root,'node_modules','typescript','bin','tsc'),'-p',configPath,...args],{cwd:root,env,shell:false,windowsHide:true,stdio:'inherit'});
      const signals=[];
      for(const signal of ['SIGINT','SIGTERM']){const stop=()=>{if(child.exitCode===null)child.kill();};process.once(signal,stop);signals.push([signal,stop]);}
      const code=await new Promise(resolve=>{child.once('error',()=>{console.error('Workspace compiler could not start. Install the pinned dependencies; no fallback was attempted.');resolve(1);});child.once('close',code=>resolve(code??1));});
      for(const [signal,stop]of signals)process.removeListener(signal,stop);
      process.exitCode=code;
      if(code===0)console.log('Verified compiler input: '+config.files.length+' explicit product sources.');
    }catch(error){console.error('Product build failed: '+(error instanceof Error?error.message:'Compiler preflight failed.'));process.exitCode=1;}
    finally {
      if(owned&&configPath) {try{const boundary=join(dirname(dirname(here)),'runtime','build');if(!within(boundary,configPath))throw new Error();const s=await lstat(configPath);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1)throw new Error();await unlink(configPath);}catch{console.error('Retained owned compiler config: inspect runtime/build before retrying.');process.exitCode=1;}}
    }
  }
}
