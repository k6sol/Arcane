import {closeSync,constants,fstatSync,lstatSync,openSync,readSync,realpathSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {basename,dirname,isAbsolute} from 'node:path';
import {LUAU_TEST_PINS} from './luau-runtime-pins.js';

/** Test fixture resolution only. No search, fallback, download or execution. */
export function resolveScenarioFixtureRuntime(env:NodeJS.ProcessEnv=process.env):string {
  if(process.arch!=='x64'||!['win32','linux'].includes(process.platform))throw new Error('Standalone Luau fixtures require Windows or Linux x64.');
  const pin=LUAU_TEST_PINS[process.platform as 'win32'|'linux'],runtime=env.ARCANE_LUAU_BIN,compiler=env.ARCANE_LUAU_COMPILE;
  if(!runtime||!compiler||!isAbsolute(runtime)||!isAbsolute(compiler)||basename(runtime)!==pin.runtime.name||basename(compiler)!==pin.compiler.name||dirname(runtime)!==dirname(compiler))
    throw new Error('Standalone Luau VM/compiler are required. Run scripts/luau-test-runtime.mjs --install and export both verified paths.');
  for(const [file,expected]of [[runtime,pin.runtime],[compiler,pin.compiler]] as const){
    const before=lstatSync(file);
    if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1||before.size!==expected.bytes||realpathSync(file)!==file)throw new Error('Invalid pinned scenario fixture runtime.');
    const descriptor=openSync(file,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
    try{
      const opened=fstatSync(descriptor),bytes=Buffer.alloc(expected.bytes+1);let length=0;
      if(opened.dev!==before.dev||opened.ino!==before.ino||opened.size!==before.size||opened.nlink!==1)throw new Error('Scenario runtime changed while opening.');
      while(length<bytes.length){const count=readSync(descriptor,bytes,length,bytes.length-length,length);if(!count)break;length+=count;}
      const after=fstatSync(descriptor),named=lstatSync(file);
      if(length!==expected.bytes||after.size!==before.size||after.mtimeMs!==before.mtimeMs||named.dev!==before.dev||named.ino!==before.ino||named.isSymbolicLink()||named.nlink!==1||
        createHash('sha256').update(bytes.subarray(0,length)).digest('hex')!==expected.sha256)throw new Error('Scenario fixture runtime hash differs from the official pin.');
    }finally{closeSync(descriptor);}
  }
  return runtime;
}
