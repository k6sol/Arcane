import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {StudioStore} from '../../packages/storage/src/studio-store.js';
import {sqliteTransportPath} from '../../packages/storage/src/sqlite-path.js';

// Actual temporary SQLite/StudioStore journals. Pairing and commands are synthetic
// storage fixtures; no Studio, network, provider or engine acceptance is exercised.
const now=1793000000000;
const foreignNames=['sqlitex_shadow','sqliteX_shadow'] as const;
type ForeignName=typeof foreignNames[number];
function directory(t:test.TestContext):string {
  const value=mkdtempSync(join(tmpdir(),'arcane-schema-prefix-'));
  t.after(()=>{assert.ok(resolve(value).startsWith(resolve(tmpdir())+sep));rmSync(value,{recursive:true,force:true});});
  return value;
}
function knownSchema(value:string,populate=true):void {
  const store=new StudioStore({directory:value,now:()=>now});
  try {
    if(populate){
      const grant=store.createGrant({allowedRoots:['Workspace'],allowWrites:false});
      const pair=store.pair({code:grant.code,protocolVersion:1,capabilities:['scene.children'],identity:{clientSessionId:'schema-prefix-fixture',placeId:0,universeId:0,name:'Schema fixture',pluginVersion:'0.1.0'}});
      store.enqueue({sessionId:pair.sessionId,requestId:'schema-prefix-retained-command',method:'scene.children',args:{root:'Workspace'}});
      store.createGrant({allowedRoots:['Workspace'],allowWrites:false});
    }
  }finally{store.close();}
}
function snapshot(file:string,foreign:ForeignName) {
  const db=new DatabaseSync(sqliteTransportPath(file),{readOnly:true});
  try {
    const schema=db.prepare('SELECT type,name,tbl_name,rootpage,sql FROM sqlite_schema ORDER BY type,name').all();
    const tables=new Set(schema.filter(row=>row.type==='table').map(row=>row.name));
    const journals=Object.fromEntries(['grants','sessions','commands','events',foreign].map(name=>[name,tables.has(name)?db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all():null]));
    return {version:db.prepare('PRAGMA user_version').get(),identity:db.prepare('PRAGMA application_id').get(),schema,journals,fileBytes:readFileSync(file)};
  }finally{db.close();}
}
for(const version of [0,6] as const)for(const foreign of foreignNames)
  test(`Studio schema rejects ${foreign} in v${version} before adoption or journal recovery`,t=>{
    const value=directory(t),file=join(value,'studio.sqlite');
    if(version===6)knownSchema(value);
    const db=new DatabaseSync(sqliteTransportPath(file));
    try {
      if(version===6)db.exec('DROP TABLE studio_native_custody;');
      // Remove the v8 addition to retain the actual v6/v7 known table shapes,
      // with the historical
      // metadata identity. v0 contains only the foreign table, exercising the
      // rows query independently of the known-schema object-count upper bound.
      db.exec(`PRAGMA application_id=0;PRAGMA user_version=${version};CREATE TABLE "${foreign}"(id INTEGER PRIMARY KEY,payload TEXT NOT NULL) STRICT;`);
      db.prepare(`INSERT INTO "${foreign}" VALUES(?,?)`).run(1,'{"retained":"foreign row source bytes"}');
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    }finally{db.close();}
    const before=snapshot(file,foreign);
    assert.equal(before.version?.user_version,version);
    assert.equal(before.identity?.application_id,0);
    if(version===6){
      assert.ok(before.journals.sessions?.length);
      assert.ok(before.journals.commands?.length);
      assert.ok(before.journals.grants?.length);
    }
    assert.throws(()=>new StudioStore({directory:value,now:()=>now+1000}),{code:'MIGRATION'});
    assert.deepEqual(snapshot(file,foreign),before,'refusal preserves full schema, version, identity, original row payloads, event journal and database bytes');
  });

test('known Studio v6 migrates with its real SQLite internal autoindexes retained',t=>{
  const value=directory(t),file=join(value,'studio.sqlite');knownSchema(value,false);
  let db=new DatabaseSync(sqliteTransportPath(file));
  const internal=()=>db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name GLOB 'sqlite_*' ORDER BY name").all();
  const before=(()=>{try {
    db.exec('DROP TABLE studio_native_custody;PRAGMA application_id=0;PRAGMA user_version=6');const rows=internal();
    assert.ok(rows.length>0,'real PRIMARY KEY/UNIQUE constraints create internal SQLite indexes');
    assert.ok(rows.every(row=>row.type==='index'&&row.sql===null&&String(row.name).startsWith('sqlite_autoindex_')));
    return rows;
  }finally{db.close();}})();
  const reopened=new StudioStore({directory:value,now:()=>now+1000});
  try{assert.deepEqual(reopened.sessions(),[]);}finally{reopened.close();}
  db=new DatabaseSync(sqliteTransportPath(file),{readOnly:true});
  try {
    assert.equal(db.prepare('PRAGMA user_version').get()?.user_version,8);
    assert.equal(db.prepare('PRAGMA application_id').get()?.application_id,0x41525354);
    const after=internal();assert.deepEqual(after.filter(row=>row.tbl_name!=='studio_native_custody'),before);
    const custody=after.filter(row=>row.tbl_name==='studio_native_custody');assert.equal(custody.length,1);
    assert.ok(custody.every(row=>row.type==='index'&&row.sql===null&&String(row.name).startsWith('sqlite_autoindex_')));
  }finally{db.close();}
});
