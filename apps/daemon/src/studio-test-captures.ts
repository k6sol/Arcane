import { createHash } from 'node:crypto';
import { mkdir, open, opendir, lstat, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { checkedDirectory } from '../../../packages/studio-test-controller/src/paths.js';
import { scenarioCaptureSchema, type ScenarioCapture, type ScenarioCaptureStore } from '../../../packages/studio-test-controller/src/scenario.js';
import { scenarioPng } from '../../../packages/studio-test-controller/src/scenario-image.js';

export async function createStudioTestCaptureStore(root: string): Promise<ScenarioCaptureStore & {read(image: ScenarioCapture): Promise<Buffer>}> {
  const directory=await checkedDirectory(join(root,'captures'),root);
  await mkdir(directory,{recursive:true,mode:0o700});
  if(await realpath(directory)!==directory)throw new Error('Capture directory changed.');
  // Retain bounded evidence without automatic deletion or identity reuse.
  let allocated=0;
  for await(const entry of await opendir(directory)){
    if(++allocated>64||!entry.isFile()||!/^([A-Za-z0-9_-]{1,64})\.png(?![\s\S])/.test(entry.name))throw new Error('Capture storage requires review.');
  }
  const path=(id:string)=>{if(!/^[A-Za-z0-9_-]{1,64}(?![\s\S])/.test(id))throw new Error('Invalid capture identity.');return join(directory,id+'.png');};
  return Object.freeze({
    async save(runId:string,bytes:Buffer,image:{width:number;height:number}) {
      const dimensions=scenarioPng(bytes);
      if(dimensions.width!==image.width||dimensions.height!==image.height)throw new Error('Capture dimensions changed.');
      if(allocated>=64)throw new Error('Capture evidence capacity reached.');
      allocated++;
      await checkedDirectory(directory,root);
      const file=await open(path(runId),'wx',0o600);
      try {await file.writeFile(bytes);await file.sync();} finally {await file.close();}
      return scenarioCaptureSchema.parse({id:runId,sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length,mimeType:'image/png',...dimensions,context:'unattested',nativeAcceptance:false});
    },
    async read(image:ScenarioCapture) {return readStudioTestCapture(root,image);},
  });
}

/** Historical reads depend on exact retained descriptor bytes and ordinary
 * capture files only, never reopening a live test ledger or recovering consent.
 * The caller supplies an original host/project guard, not a request path. */
export async function readStudioTestCapture(root:string,image:ScenarioCapture,guard:()=>void=()=>{}):Promise<Buffer> {
  guard();const value=scenarioCaptureSchema.parse(image);
  const directory=await checkedDirectory(join(root,'captures'),root);guard();
  if(!/^[A-Za-z0-9_-]{1,64}(?![\s\S])/.test(value.id))throw new Error('Invalid capture identity.');
  const location=join(directory,value.id+'.png'),before=await lstat(location);guard();
  if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1||before.size!==value.bytes)throw new Error('Capture identity changed.');
  const file=await open(location,'r');
  try {
    guard();const actual=await file.stat();guard();
    if(actual.dev!==before.dev||actual.ino!==before.ino||actual.size!==before.size||actual.nlink!==1)throw new Error('Capture identity changed.');
    // Read at most the declared bounded image plus one overflow byte, even if
    // an ordinary file grows after its pre-read stat.
    const buffer=Buffer.alloc(value.bytes+1);let used=0;
    while(used<buffer.length){guard();const read=await file.read(buffer,used,buffer.length-used,used);guard();if(read.bytesRead===0)break;used+=read.bytesRead;}
    const bytes=buffer.subarray(0,used);
    if(bytes.length!==value.bytes||createHash('sha256').update(bytes).digest('hex')!==value.sha256)throw new Error('Capture bytes changed.');
    return bytes;
  } finally {
    // Cancellation never skips closing the already-owned descriptor.
    try{guard();}finally{await file.close();}guard();
  }
}
