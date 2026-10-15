import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const source=readFileSync(new URL('../../.github/workflows/verify.yml',import.meta.url),'utf8').replaceAll('\r\n','\n');
const block=source.match(/^concurrency:\n((?:[ \t]+[^\n]*\n)+)/m)?.[1]??'';
const expression=block.match(/^  group: (.+)$/m)?.[1]??'';
const group=values=>expression.replace(/\$\{\{\s*github\.(workflow|ref|sha)\s*\}\}/g,(_,name)=>values[name]);

test('verification gives each pushed revision an independent concurrency group',()=>{
  for(const name of ['workflow','ref','sha'])assert.ok(expression.includes('${{ github.'+name+' }}'));
  const branch={workflow:'Verify Arcane local components',ref:'refs/heads/main'};
  assert.notEqual(group({...branch,sha:'a'.repeat(40)}),group({...branch,sha:'b'.repeat(40)}));
  assert.equal(group({...branch,sha:'a'.repeat(40)}),group({...branch,sha:'a'.repeat(40)}));
});

test('a new update cannot cancel an already running verification',()=>{
  assert.match(block,/^  cancel-in-progress: false$/m);
  assert.match(source,/os: \[ubuntu-latest, windows-latest\]/);
  assert.match(source,/run: npm test/);
});
