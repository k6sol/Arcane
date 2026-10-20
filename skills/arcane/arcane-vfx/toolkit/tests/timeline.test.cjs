const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const timeline = require('../skills/arcane-vfx/scripts/timeline.cjs');
const spec = JSON.parse(fs.readFileSync(path.join(__dirname,'../examples/ember-impact.json'),'utf8'));

test('scrubbing is independent of previous evaluation order', () => {
  const expected = timeline.sample(spec,.6);
  timeline.sample(spec,2); timeline.sample(spec,.1);
  assert.deepEqual(timeline.sample(spec,.6),expected);
  assert.equal(timeline.sample(spec,timeline.end(spec)).length,0);
  assert.throws(()=>timeline.sample(spec,NaN));
});
test('reordering layers preserves each named layer particle stream', () => {
  const points = value => timeline.sample(value,.6).map(p=>({id:value.layers[p.layer].id,index:p.index,position:p.position})).sort((a,b)=>a.id.localeCompare(b.id)||a.index-b.index);
  const reordered = {...spec,layers:[...spec.layers].reverse()};
  assert.deepEqual(points(reordered),points(spec));
});
test('seeded cone and drag match the Python authoring evaluator', t => {
  const python = process.env.VFX_TEST_PYTHON;
  if (!python) return t.skip('Set VFX_TEST_PYTHON to run cross-language parity.');
  const script = "import sys,json;sys.path.insert(0,'skills/arcane-vfx/scripts');import effect;s=effect.read_spec('examples/ember-impact.json');print(json.dumps([effect.sample(s,t) for t in [0,.03,.1,.25,.5,1,2,2.68]]))";
  const r = spawnSync(python,['-B','-c',script],{cwd:path.join(__dirname,'..'),encoding:'utf8',windowsHide:true,timeout:15000});
  assert.equal(r.status,0,r.stderr);
  const expected = JSON.parse(r.stdout), times=[0,.03,.1,.25,.5,1,2,2.68];
  expected.forEach((points,i)=>{
    const actual=timeline.sample(spec,times[i]); assert.equal(actual.length,points.length);
    points.forEach((p,k)=>{
      assert.equal(actual[k].layer,p.layer);assert.equal(actual[k].index,p.index);
      for(const key of ['age','size','alpha']) assert.ok(Math.abs(actual[k][key]-p[key])<1e-10);
      p.position.forEach((v,j)=>assert.ok(Math.abs(actual[k].position[j]-v)<1e-10));
    });
  });
});
