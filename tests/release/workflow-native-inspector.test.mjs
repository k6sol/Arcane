import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {stripTypeScriptTypes} from 'node:module';
import {Script} from 'node:vm';
import {win32} from 'node:path';
import {historicalInspectionCandidate,inspectionOnlyCandidate,inspectionOnlyLegacy} from '../../scripts/check-receipt-inspector-equivalence.mjs';
const source=readFileSync(new URL('../../apps/daemon/src/workflow-private-storage.ts',import.meta.url),'utf8').replaceAll('\r\n','\n');
const marker='const SCRIPT=String.raw`',start=source.indexOf(marker)+marker.length,end=source.indexOf('\n`;',start);
assert.ok(start>=marker.length&&end>start);const script=source.slice(start,end)+'\n';
const hash=value=>createHash('sha256').update(value).digest('hex');

// Static/native boundary DOUBLE proof. Current native acceptance is the separate
// owner/refusal suite; the comparison tool retains the historical experiment.
test('current startup policy and historical read-inspector experiment remain separately source pinned',()=>{
  assert.equal(hash(script),'5afafdb2fe946e8805c3d7221654ad28bac8de470ae23450a190e07b10017e08');
  const historical=historicalInspectionCandidate();
  assert.equal(hash(historical),'9e80f4b7b3563233fa936c57c2a50316eac345c5ef3eb79457caa4d1ffd52f3e');
  const legacy=inspectionOnlyLegacy(historical);
  assert.equal(hash(legacy),'095214e83f2b94fdbade1f1086db4400aa2388d2198039f0aab87a8bd03637b8');
  assert.equal(inspectionOnlyCandidate(legacy),historical);
});

test('native inspection keeps strict ancestry/DACL rules and binds default ownership to one trusted host token',()=>{
  for(const predicate of [
    '$allowed=@($user.Value,\'S-1-5-18\',\'S-1-5-32-544\')',
    '[Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles',
    '[Security.AccessControl.FileSystemRights]::ChangePermissions',
    '[Security.AccessControl.FileSystemRights]::TakeOwnership',
    '[Security.AccessControl.PropagationFlags]::InheritOnly',
    '$acl.AreAccessRulesProtected', '$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $user.Value',
    '$allowed -notcontains $rule.IdentityReference.Value', '$item.Length -ne 32',
    '[IO.FileAttributes]::ReparsePoint', '$at=$parent.FullName',
    "if(-not $prepare -or [IO.File]::Exists($dir)){throw 'missing'}",
    '$entries=[IO.Directory]::EnumerateFileSystemEntries($dir).GetEnumerator()',
    'try{$empty=-not $entries.MoveNext()}finally{if($entries -is [IDisposable]){$entries.Dispose()}}',
    "if(-not $empty){throw 'created-scope'}",
    '$acl.SetAccessRuleProtection($true,$false)', '[IO.Directory]::SetAccessControl($dir,$acl)',
  ]) assert.ok(script.includes(predicate),predicate);
  assert.equal((script.match(/\[IO\.Directory\]::SetAccessControl/g)??[]).length,1);
  assert.ok(script.indexOf('[IO.Directory]::SetAccessControl')>script.indexOf('if(-not [IO.Directory]::Exists($dir))'));
  assert.ok(script.includes('[IO.Directory]::GetAccessControl($path)'));
  assert.ok(script.includes('[IO.File]::GetAccessControl($path)'));
  assert.equal((script.match(/\[Security\.Principal\.WindowsIdentity\]::GetCurrent\(\)/g)??[]).length,1);
  for(const predicate of [
    '$user=$identity.User', '$defaultOwner=$identity.Owner',
    "if($null -eq $user -or $null -eq $defaultOwner){throw 'token-owner'}",
    "if($allowed -notcontains $defaultOwner.Value){throw 'token-owner'}",
    '$prior.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin @($user.Value,$defaultOwner.Value)',
    "if(-not (IsDirectory $item) -or -not $acl.AreAccessRulesProtected -or $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $user.Value){throw 'private-dir'}",
    "if((IsDirectory $item) -or $item.Length -ne 32 -or $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin @($user.Value,$defaultOwner.Value)){throw 'private-key'}",
  ]) assert.ok(script.includes(predicate),predicate);
  assert.equal((script.match(/-notin @\(\$user.Value,\$defaultOwner.Value\)/g)??[]).length,2);
  assert.ok(script.indexOf('if($allowed -notcontains $defaultOwner.Value)')<script.indexOf('[IO.Directory]::CreateDirectory'));
  assert.ok(script.indexOf("throw 'private-dir-rule'")<script.indexOf('if($key)'));
});

test('current native startup avoids module discovery while preserving the bounded fixed descriptor',()=>{
  assert.ok(script.includes("$PSModuleAutoLoadingPreference='None'"));
  for(const command of ['Get-Item','Get-Acl','Get-ChildItem','New-Object','Set-Acl','ConvertTo-Json'])
    assert.equal(script.includes(command),false,command);
  assert.ok(script.includes('[Security.AccessControl.DirectorySecurity]::new()'));
  assert.ok(script.includes('[Security.Principal.SecurityIdentifier]::new($sid)'));
  assert.ok(script.includes('[Security.AccessControl.FileSystemAccessRule]::new('));
  assert.ok(script.includes("$createdJson=if($created){'true'}else{'false'}"));
  assert.ok(script.includes("$keyJson=if($key){'true'}else{'false'}"));
  assert.ok(script.includes('[Console]::Write(\'{"version":1,"created":\'+$createdJson+\',"directoryPrivate":true,"keyPrivate":\'+$keyJson+\',"ancestorsSafe":true}\')'));
});

function boundary(result={},pathFailure=false) {
  const calls=[];class ArcaneError extends Error {constructor(code,message){super(message);this.code=code;}}
  const data={version:1,created:false,directoryPrivate:true,keyPrivate:true,ancestorsSafe:true};
  const defaultResult={status:0,signal:null,stdout:JSON.stringify(data)};
  const code=stripTypeScriptTypes(source,{mode:'strip'}).replace(/^import[^;]+;\n/gm,'').replace(/^export /gm,'');
  const context={ArcaneError,Buffer,Object,Array,JSON,String,Boolean,Number,process:{platform:'win32',env:{SystemRoot:'C:\\Windows'}},
    isAbsolute:win32.isAbsolute,join:win32.join,resolve:win32.resolve,
    lstatSync:path=>({isDirectory:()=>path==='C:\\fixture',isFile:()=>path.endsWith('powershell.exe'),isSymbolicLink:()=>pathFailure}),
    realpathSync:{native:path=>path},spawnSync:(...args)=>{calls.push(args);return {...defaultResult,...result};}};
  const inspect=new Script(code+'\nprivateWorkflowReceiptStorage;',{filename:'exact-private-storage-source'}).runInNewContext(context);
  return {inspect,calls};
}

test('exact production native boundary retains one fixed checker, five-second bound and no caller script/command',()=>{
  const f=boundary();f.inspect('C:\\fixture',false,true);assert.equal(f.calls.length,1);
  const [executable,args,options]=f.calls[0];assert.equal(executable,'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.deepEqual(Array.from(args).slice(0,4),['-NoLogo','-NoProfile','-NonInteractive','-Command']);
  assert.equal(args[4],script);assert.equal(options.timeout,5000);assert.equal(options.maxBuffer,16384);
  assert.equal(options.shell,false);assert.equal(options.windowsHide,true);assert.equal(options.encoding,'utf8');
  assert.deepEqual(Array.from(options.stdio),['ignore','pipe','pipe']);
  assert.equal(options.env.ARCANE_WORKFLOW_ACL_ROOT,'C:\\fixture');
  assert.equal(options.env.ARCANE_WORKFLOW_ACL_PREPARE,'0');assert.equal(options.env.ARCANE_WORKFLOW_ACL_KEY,'1');
});

test('exact native boundary refuses process failure, unknown proof and unsafe path before any key-reading authority',()=>{
  for(const result of [{status:1},{signal:'SIGTERM'},{error:{code:'ETIMEDOUT'}},{stdout:'invalid-json'},
    {stdout:JSON.stringify({version:1,created:false,directoryPrivate:true,keyPrivate:true,ancestorsSafe:false})},
    {stdout:JSON.stringify({version:1,created:true,directoryPrivate:true,keyPrivate:true,ancestorsSafe:true})},
    {stdout:' '.repeat(2049)}]) {
    const f=boundary(result);assert.throws(()=>f.inspect('C:\\fixture',false,true),{code:'WORKFLOW_RECEIPT_STORAGE'});assert.equal(f.calls.length,1);
  }
  for(const path of ['relative','\\\\server\\share','C:\\fixture\n','//server/share']) {
    const f=boundary();assert.throws(()=>f.inspect(path,false,true),{code:'WORKFLOW_RECEIPT_STORAGE'});assert.equal(f.calls.length,0);
  }
  const linked=boundary({},true);assert.throws(()=>linked.inspect('C:\\fixture',false,true),{code:'WORKFLOW_RECEIPT_STORAGE'});assert.equal(linked.calls.length,0);
});
