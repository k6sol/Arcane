import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {packSkills} from '../../scripts/skill-pack.mjs';
const root=fileURLToPath(new URL('../..',import.meta.url));
test('portable VFX resources are available through the skill registry',async()=>{
 const result=await packSkills(['arcane-vfx'],{root,allowExperimental:true,byteBudget:65536,references:['arcane-vfx:portable','arcane-vfx:format','arcane-vfx:playback','arcane-vfx:runtime']});
 assert.equal(result.references.length,4);assert.equal(result.approvalChanged,false);
 const data=JSON.parse(await readFile(new URL('../../skills/arcane/arcane-vfx/toolkit/examples/icy-impact.json',import.meta.url),'utf8'));
 assert.equal(data.version,1);assert.ok(data.layers.every(l=>l.life[1]<=20));
});
