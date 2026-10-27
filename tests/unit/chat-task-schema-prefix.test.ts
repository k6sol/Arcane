import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdirSync,mkdtempSync,readFileSync,readdirSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {isAbsolute,join,relative,sep} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {ChatTaskStore} from '../../packages/storage/src/chat-task-store.js';
import {sqliteTransportPath} from '../../packages/storage/src/sqlite-path.js';

// Actual temporary task journals and SQLite schema checks only. No provider,
// SDK, native process, Studio or task replay is exercised by these fixtures.
const foreignNames=['sqlitex_shadow','sqliteX_shadow'] as const;
type ForeignName=typeof foreignNames[number];
function fixture(t:test.TestContext){
  const boundary=realpathSync(tmpdir()),root=mkdtempSync(join(boundary,'arcane-task-schema-prefix-'));
  const directory=join(root,'state'),projectPath=join(root,'project');mkdirSync(directory);mkdirSync(projectPath);
  t.after(()=>{const tail=relative(boundary,root);assert.ok(tail.startsWith('arcane-task-schema-prefix-')&&!isAbsolute(tail)&&!tail.includes(sep));rmSync(root,{recursive:true,force:true});});
  return{directory,projectPath,file:join(directory,'chat-tasks.sqlite')};
}
function knownSchema(f:ReturnType<typeof fixture>,state:'working'|'cancelled'='working'){
  const store=new ChatTaskStore(f);
  try{
    return store.create({id:randomUUID(),provider:'codex',threadId:'schema-prefix-thread',sessionId:null,connectionId:randomUUID(),incarnationId:randomUUID(),
      model:'fixture-model',effort:'low',allowWorkspaceWrites:false,allowAssets:false,state,round:0,operationId:null,turnId:null,nativeSettled:false,
      acknowledged:false,repairDispatch:'not_requested',prepared:null,evidence:[],reason:null});
  }finally{store.close();}
}
function snapshot(f:ReturnType<typeof fixture>,foreign:ForeignName){
  const db=new DatabaseSync(sqliteTransportPath(f.file),{readOnly:true,allowExtension:false});
  try{
    const schema=db.prepare('SELECT type,name,tbl_name,rootpage,sql FROM sqlite_schema ORDER BY type,name').all();
    const tables=new Set(schema.filter(row=>row.type==='table').map(row=>row.name));
    const journals=Object.fromEntries(['chat_tasks','chat_task_meta','chat_task_owner','chat_task_proposals','chat_task_plans','chat_task_plan_steps',foreign]
      .map(name=>[name,tables.has(name)?db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all():null]));
    return{version:db.prepare('PRAGMA user_version').get(),identity:db.prepare('PRAGMA application_id').get(),schema,journals};
  }finally{db.close();}
}
for(const version of [0,4] as const)for(const foreign of foreignNames)
  test(`task schema refuses ${foreign} in v${version} before adoption, ownership or recovery`,t=>{
    const f=fixture(t),task=version===4?knownSchema(f):null,db=new DatabaseSync(sqliteTransportPath(f.file),{allowExtension:false});
    try{
      assert.equal(db.prepare('PRAGMA user_version').get()?.user_version,version);
      db.exec(`CREATE TABLE "${foreign}"(id INTEGER PRIMARY KEY,payload TEXT NOT NULL) STRICT`);
      db.prepare(`INSERT INTO "${foreign}" VALUES(?,?)`).run(1,'{"retained":"foreign source bytes"}');
      // Normalize only fixture setup so refused opening cannot hide a WAL-mode
      // switch or ownership/recovery write behind an existing sidecar.
      db.exec('PRAGMA wal_checkpoint(TRUNCATE);PRAGMA journal_mode=DELETE;');
    }finally{db.close();}
    const before=snapshot(f,foreign),bytes=readFileSync(f.file),names=readdirSync(f.directory).sort();
    assert.equal(before.version?.user_version,version);assert.equal(before.identity?.application_id,version===0?0:0x41524354);
    if(task){assert.equal(before.journals.chat_tasks?.length,1);assert.equal(before.journals.chat_task_owner?.length,0);}
    assert.throws(()=>new ChatTaskStore(f),version===0?/Unversioned task journal is not empty/:/Task journal schema or project changed/);
    assert.deepEqual(snapshot(f,foreign),before,'full schema, identity, original payloads and owner journal stay unchanged');
    assert.deepEqual(readFileSync(f.file),bytes,'refusal neither adopts schema nor rewrites original working task for recovery');
    assert.deepEqual(readdirSync(f.directory).sort(),names,'refusal does not create SQLite sidecars');
  });

test('known current task schema accepts its genuine SQLite internal autoindexes',t=>{
  const f=fixture(t),task=knownSchema(f,'cancelled');
  const internal=()=>{const db=new DatabaseSync(sqliteTransportPath(f.file),{readOnly:true,allowExtension:false});try{return db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name GLOB 'sqlite_*' ORDER BY name").all();}finally{db.close();}};
  const before=internal();assert.ok(before.length>0,'real task PRIMARY KEY and UNIQUE constraints create internal indexes');
  assert.ok(before.every(row=>row.type==='index'&&row.sql===null&&String(row.name).startsWith('sqlite_autoindex_')));
  const reopened=new ChatTaskStore(f);try{assert.deepEqual(reopened.get(task.id),task);}finally{reopened.close();}
  assert.deepEqual(internal(),before,'literal internal-prefix exemption preserves legitimate autoindexes');
});
