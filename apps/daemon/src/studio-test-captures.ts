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
    async read(image:ScenarioCapture) {
      const value=scenarioCaptureSchema.parse(image);await checkedDirectory(directory,root);
      const location=path(value.id),before=await lstat(location);
      if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1||before.size!==value.bytes)throw new Error('Capture identity changed.');
      const file=await open(location,'r');
      try {
        const actual=await file.stat();if(actual.dev!==before.dev||actual.ino!==before.ino||actual.size!==before.size||actual.nlink!==1)throw new Error('Capture identity changed.');
        const bytes=await file.readFile();
        if(bytes.length!==value.bytes||createHash('sha256').update(bytes).digest('hex')!==value.sha256)throw new Error('Capture bytes changed.');
        return bytes;
      } finally {await file.close();}
    },
  });
}
