import childProcess from 'node:child_process';
import {lstatSync,mkdtempSync,readFileSync,realpathSync,rmdirSync,unlinkSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {nativeMetadataJsonSetup} from './windows-private-permission-fixture.js';

// Test-only native metadata doubles, backed by real in-memory .NET ACL/SID
// objects. None of these classes can change a token or a real filesystem ACL.
export const ownerPolicyFixture = nativeMetadataJsonSetup + String.raw`
class ArcaneOwnerFixtureState {
  static [object] $Case
  static [Security.Principal.SecurityIdentifier] $User
  static [object] $DirectoryAcl
  static [object] $KeyAcl
  static [object] $AncestorAcl
  static [bool] $DirectoryExists
  static [int] $Identities
  static [int] $Creates
  static [int] $Writes
  static [string] $Root='C:\arcane-owner-fixture'
  static [string] $Child='C:\arcane-owner-fixture\workflow-human-receipts'
  static [string] $Key='C:\arcane-owner-fixture\workflow-human-receipts\key-v1'
  static [IO.FileAttributes] Attributes([string]$path) {
    if($path -ceq [ArcaneOwnerFixtureState]::Key){
      if([ArcaneOwnerFixtureState]::Case.keyReparse){return [IO.FileAttributes]::ReparsePoint}
      return [IO.FileAttributes]::Normal
    }
    if($path -ceq [ArcaneOwnerFixtureState]::Root -and [ArcaneOwnerFixtureState]::Case.ancestorReparse){return [IO.FileAttributes]::Directory -bor [IO.FileAttributes]::ReparsePoint}
    return [IO.FileAttributes]::Directory
  }
}
class ArcaneOwnerFixtureIdentity {
  [Security.Principal.SecurityIdentifier] $User
  [Security.Principal.SecurityIdentifier] $Owner
  static [ArcaneOwnerFixtureIdentity] GetCurrent() {
    [ArcaneOwnerFixtureState]::Identities++
    $identity=[ArcaneOwnerFixtureIdentity]::new()
    $identity.User=[ArcaneOwnerFixtureState]::User
    if([ArcaneOwnerFixtureState]::Case.defaultOwner -ne 'null'){$identity.Owner=[Security.Principal.SecurityIdentifier]::new([ArcaneOwnerFixtureState]::Case.defaultOwner)}
    return $identity
  }
}
class ArcaneOwnerFixtureItem {
  [IO.FileAttributes] $Attributes
  [long] $Length
  ArcaneOwnerFixtureItem([string]$path) {
    $this.Attributes=[ArcaneOwnerFixtureState]::Attributes($path)
    $this.Length=[ArcaneOwnerFixtureState]::Case.keyLength
  }
  [void] Refresh() {}
}
class ArcaneOwnerFixtureDirectory {
  static [bool] Exists([string]$path) {
    if($path -ceq [ArcaneOwnerFixtureState]::Child){return [ArcaneOwnerFixtureState]::DirectoryExists}
    return $path -cne [ArcaneOwnerFixtureState]::Key
  }
  static [object] GetParent([string]$path) {
    if($path -ceq 'C:\'){return $null}
    return @{FullName='C:\'}
  }
  static [object] CreateDirectory([string]$path) {
    if($path -cne [ArcaneOwnerFixtureState]::Child){throw 'fixture-create-scope'}
    [ArcaneOwnerFixtureState]::Creates++
    [ArcaneOwnerFixtureState]::DirectoryExists=$true
    return [ArcaneOwnerFixtureItem]::new($path)
  }
  static [object] GetAccessControl([string]$path) {
    if($path -ceq [ArcaneOwnerFixtureState]::Child){return [ArcaneOwnerFixtureState]::DirectoryAcl}
    return [ArcaneOwnerFixtureState]::AncestorAcl
  }
  static [void] SetAccessControl([string]$path,[Security.AccessControl.DirectorySecurity]$acl) {
    if($path -cne [ArcaneOwnerFixtureState]::Child){throw 'fixture-write-scope'}
    [ArcaneOwnerFixtureState]::Writes++
    [ArcaneOwnerFixtureState]::DirectoryAcl=$acl
  }
  static [string[]] EnumerateFileSystemEntries([string]$path) {
    if($path -cne [ArcaneOwnerFixtureState]::Child){throw 'fixture-entries-scope'}
    if([ArcaneOwnerFixtureState]::Case.nonempty){return @('fixture-entry')}
    return @()
  }
}
class ArcaneOwnerFixtureFile {
  static [bool] Exists([string]$path) {return $path -ceq [ArcaneOwnerFixtureState]::Key}
  static [IO.FileAttributes] GetAttributes([string]$path) {return [ArcaneOwnerFixtureState]::Attributes($path)}
  static [object] GetAccessControl([string]$path) {return [ArcaneOwnerFixtureState]::KeyAcl}
}
function FixtureAcl([string]$owner,[bool]$protected,[bool]$foreign) {
  $acl=[Security.AccessControl.DirectorySecurity]::new()
  $acl.SetOwner([Security.Principal.SecurityIdentifier]::new($owner))
  $acl.SetAccessRuleProtection($protected,$false)
  foreach($sid in @([ArcaneOwnerFixtureState]::User.Value,'S-1-5-18','S-1-5-32-544')){
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sid),[Security.AccessControl.FileSystemRights]::FullControl,[Security.AccessControl.AccessControlType]::Allow))
  }
  if($foreign){$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-1-0'),[Security.AccessControl.FileSystemRights]::Read,[Security.AccessControl.AccessControlType]::Allow))}
  return $acl
}
function Set-Acl($LiteralPath,$AclObject) {
  if($LiteralPath -cne [ArcaneOwnerFixtureState]::Child){throw 'fixture-write-scope'}
  [ArcaneOwnerFixtureState]::Writes++
  [ArcaneOwnerFixtureState]::DirectoryAcl=$AclObject
}
function Get-ChildItem($LiteralPath,[switch]$Force) {
  if($LiteralPath -cne [ArcaneOwnerFixtureState]::Child){throw 'fixture-entries-scope'}
  if([ArcaneOwnerFixtureState]::Case.nonempty){return 'fixture-entry'}
}
$caseData=$nativeJson.DeserializeObject($env:ARCANE_OWNER_FIXTURE_CASE)
[ArcaneOwnerFixtureState]::Case=@{}
foreach($field in $caseData.Keys){[ArcaneOwnerFixtureState]::Case[$field]=$caseData[$field]}
[ArcaneOwnerFixtureState]::User=[Security.Principal.SecurityIdentifier]::new('S-1-5-21-100-200-300-1001')
$case=[ArcaneOwnerFixtureState]::Case
[ArcaneOwnerFixtureState]::DirectoryExists=$case.existing
[ArcaneOwnerFixtureState]::DirectoryAcl=FixtureAcl $case.directoryOwner $case.protected $case.directoryForeign
[ArcaneOwnerFixtureState]::KeyAcl=FixtureAcl $case.keyOwner $false $case.keyForeign
[ArcaneOwnerFixtureState]::AncestorAcl=FixtureAcl ([ArcaneOwnerFixtureState]::User.Value) $false $false
if($case.unsafeAncestor){[ArcaneOwnerFixtureState]::AncestorAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-1-0'),[Security.AccessControl.FileSystemRights]::Delete,[Security.AccessControl.AccessControlType]::Allow))}
$sections=[Security.AccessControl.AccessControlSections]::Owner -bor [Security.AccessControl.AccessControlSections]::Access
$beforeDirectory=[ArcaneOwnerFixtureState]::DirectoryAcl.GetSecurityDescriptorSddlForm($sections)
$beforeKey=[ArcaneOwnerFixtureState]::KeyAcl.GetSecurityDescriptorSddlForm($sections)
`;


export const OWNER_POLICY_FIXTURE_SHA256 = '6bb99b1e9baf2dfc21c26ae3479846b8de73d702cc246f69f590b7e37b77738e';
/** New bounded environment preparation, not a production/query deadline.
 * Production checks keep fresh processes and their original 5s cap; the
 * metadata-only matrix below keeps a separate 5s bound for every request. */
export const OWNER_POLICY_PREPARATION_MS = 15_000;
const preparationCase = Object.freeze({defaultOwner:'S-1-5-32-544',directoryOwner:'S-1-5-32-544',keyOwner:'S-1-5-32-544',
  existing:false,protected:false,directoryForeign:false,keyForeign:false,nonempty:false,unsafeAncestor:false,
  ancestorReparse:false,keyReparse:false,keyLength:32});
export const ownerPolicyPreparationScript = "$ErrorActionPreference='Stop'\n" + ownerPolicyFixture + String.raw`
# Exercise the actual typed-class/static-method/ACL-object paths only. The
# complete production policy is deliberately NOT a discarded preparation case.
if([ArcaneOwnerFixtureState]::Identities -ne 0 -or [ArcaneOwnerFixtureState]::Creates -ne 0 -or [ArcaneOwnerFixtureState]::Writes -ne 0){throw 'fixture-initial-state'}
$identity=[ArcaneOwnerFixtureIdentity]::GetCurrent()
if($identity.User.Value -cne 'S-1-5-21-100-200-300-1001' -or $identity.Owner.Value -cne 'S-1-5-32-544'){throw 'fixture-identity'}
$null=[ArcaneOwnerFixtureDirectory]::CreateDirectory([ArcaneOwnerFixtureState]::Child)
$item=[ArcaneOwnerFixtureItem]::new([ArcaneOwnerFixtureState]::Child); $item.Refresh()
if(-not [ArcaneOwnerFixtureDirectory]::Exists([ArcaneOwnerFixtureState]::Child) -or $item.Attributes -ne [IO.FileAttributes]::Directory -or $item.Length -ne 32){throw 'fixture-directory'}
$acl=FixtureAcl ([ArcaneOwnerFixtureState]::User.Value) $true $false
[ArcaneOwnerFixtureDirectory]::SetAccessControl([ArcaneOwnerFixtureState]::Child,$acl)
$observed=[ArcaneOwnerFixtureDirectory]::GetAccessControl([ArcaneOwnerFixtureState]::Child)
$key=[ArcaneOwnerFixtureFile]::GetAccessControl([ArcaneOwnerFixtureState]::Key)
if(-not [ArcaneOwnerFixtureFile]::Exists([ArcaneOwnerFixtureState]::Key) -or [ArcaneOwnerFixtureFile]::GetAttributes([ArcaneOwnerFixtureState]::Key) -ne [IO.FileAttributes]::Normal){throw 'fixture-key'}
if($null -ne [ArcaneOwnerFixtureDirectory]::GetParent('C:\')){throw 'fixture-ancestor'}
$entries=@([ArcaneOwnerFixtureDirectory]::EnumerateFileSystemEntries([ArcaneOwnerFixtureState]::Child))
if($entries.Count -ne 0){throw 'fixture-entries'}
$nativeJson.MaxJsonLength=8192
[Console]::Write($nativeJson.Serialize(@{kind='owner-policy-fixture-prepared';version=1;identities=[ArcaneOwnerFixtureState]::Identities;creates=[ArcaneOwnerFixtureState]::Creates;writes=[ArcaneOwnerFixtureState]::Writes;directoryOwnerIsUser=($observed.GetOwner([Security.Principal.SecurityIdentifier]).Value -eq [ArcaneOwnerFixtureState]::User.Value);directoryProtected=$observed.AreAccessRulesProtected;keyUnchanged=($key.GetSecurityDescriptorSddlForm($sections) -ceq $beforeKey)}))
`;
export interface OwnerPolicyPreparation {kind:'owner-policy-fixture-prepared';version:1;identities:1;creates:1;writes:1;directoryOwnerIsUser:true;directoryProtected:true;keyUnchanged:true}
export function decodeOwnerPolicyPreparation(value:unknown):OwnerPolicyPreparation {
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Owner-policy fixture preparation did not report its exact in-memory checks.');
  const expected={kind:'owner-policy-fixture-prepared',version:1,identities:1,creates:1,writes:1,directoryOwnerIsUser:true,directoryProtected:true,keyUnchanged:true};
  const fields=Object.keys(value);
  if(fields.length!==Object.keys(expected).length||Object.entries(expected).some(([key,wanted])=>!Object.hasOwn(value,key)||(value as Record<string,unknown>)[key]!==wanted))
    throw new Error('Owner-policy fixture preparation did not report its exact in-memory checks.');
  return value as OwnerPolicyPreparation;
}
export function prepareWindowsOwnerPolicyFixture():OwnerPolicyPreparation {
  if(process.platform!=='win32')throw new Error('Owner-policy fixture preparation requires Windows.');
  const windows=process.env.SystemRoot??'C:\\Windows';
  if(!/^[A-Za-z]:\\Windows$/i.test(windows))throw new Error('Owner-policy fixture preparation requires the native Windows PowerShell host.');
  const executable=join(windows,'System32','WindowsPowerShell','v1.0','powershell.exe'),stat=lstatSync(executable);
  if(!stat.isFile()||stat.isSymbolicLink()||realpathSync.native(executable).toLowerCase()!==executable.toLowerCase())
    throw new Error('Owner-policy fixture preparation requires the native Windows PowerShell host.');
  const result=childProcess.spawnSync(executable,['-NoLogo','-NoProfile','-NonInteractive','-Command',ownerPolicyPreparationScript],{
    env:{...process.env,PSModulePath:join(windows,'System32','WindowsPowerShell','v1.0','Modules'),
      ARCANE_OWNER_FIXTURE_CASE:JSON.stringify(preparationCase)},
    shell:false,windowsHide:true,timeout:OWNER_POLICY_PREPARATION_MS,maxBuffer:16384,encoding:'utf8',stdio:['ignore','pipe','pipe'],
  });
  if(result.error||result.signal||result.status!==0||result.stderr!==''||Buffer.byteLength(result.stdout)>2048)
    throw new Error('Bounded owner-policy fixture preparation failed; no policy query was retried.');
  let value:unknown;try{value=JSON.parse(result.stdout);}catch{throw new Error('Owner-policy fixture preparation returned invalid metadata.');}
  return decodeOwnerPolicyPreparation(value);
}

// The metadata matrix has no real filesystem/token operations. Keep one owned
// host for its cases, not cached ACL results or a replacement production checker.
export const OWNER_POLICY_HOST_MS = 5_000, OWNER_POLICY_QUERY_MS = 5_000;
export interface OwnerPolicyCase {
  defaultOwner:string;directoryOwner:string;keyOwner:string;existing:boolean;protected:boolean;
  directoryForeign:boolean;keyForeign:boolean;nonempty:boolean;unsafeAncestor:boolean;
  ancestorReparse:boolean;keyReparse:boolean;keyLength:number;
}
export interface OwnerPolicyResult {status:0|1;stdout:string;stderr:string}
const refusalTail = "} catch { [Console]::Error.WriteLine('Arcane private workflow storage unavailable.'); exit 1 }";
const refusalThrow = "} catch { [Console]::Error.WriteLine('Arcane private workflow storage unavailable.'); throw [ArcaneOwnerFixtureRefusal]::new() }";
/** The only control-flow seam keeps an expected refusal inside this test host.
 * Its exact inverse must recover every policy byte, including the original catch. */
export function ownerPolicyRefusalSeam(source:string):string {
  if(source.split(refusalTail).length!==2 || !source.endsWith(refusalTail+'\n') || source.includes('ArcaneOwnerFixtureRefusal'))
    throw new Error('Expected one exact terminal policy refusal.');
  const result=source.replace(refusalTail,refusalThrow);
  if(result.replace(refusalThrow,refusalTail)!==source)throw new Error('Policy refusal seam did not roundtrip.');
  return result;
}
export function decodeOwnerPolicyResult(value:unknown,id:number):OwnerPolicyResult {
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid owner-policy host response.');
  const v=value as Record<string,unknown>;
  if(Object.keys(v).sort().join(',')!=='id,status,stderr,stdout,version'||v.version!==1||v.id!==id||
      (v.status!==0&&v.status!==1)||typeof v.stdout!=='string'||typeof v.stderr!=='string'||
      Buffer.byteLength(v.stdout)>2048||Buffer.byteLength(v.stderr)>8192)throw new Error('Invalid owner-policy host response.');
  return {status:v.status,stdout:v.stdout,stderr:v.stderr};
}
function ownerCase(value:OwnerPolicyCase):void {
  const fields=Object.keys(preparationCase).sort();
  if(!value||typeof value!=='object'||Object.keys(value).sort().join(',')!==fields.join(','))throw new Error('Invalid owner-policy case.');
  for(const key of fields) {
    const v=(value as unknown as Record<string,unknown>)[key];
    if(['defaultOwner','directoryOwner','keyOwner'].includes(key)) {
      if(typeof v!=='string'||!(key==='defaultOwner'&&v==='null')&&!/^S-1-\d+(?:-\d+){1,12}$/.test(v)||v.length>160)throw new Error('Invalid fixture SID.');
    } else if(key==='keyLength') { if(!Number.isSafeInteger(v)||Number(v)<0||Number(v)>64)throw new Error('Invalid fixture key length.'); }
    else if(typeof v!=='boolean')throw new Error('Invalid fixture flag.');
  }
}
function ownerPolicyHostScript(current:string,previous:string):string {
  const marker='$caseData=$nativeJson.DeserializeObject($env:ARCANE_OWNER_FIXTURE_CASE)';
  if(ownerPolicyFixture.split(marker).length!==2)throw new Error('Unexpected fixture setup boundary.');
  const at=ownerPolicyFixture.indexOf(marker),definitions=ownerPolicyFixture.slice(0,at),reset=ownerPolicyFixture.slice(at);
  if(definitions+reset!==ownerPolicyFixture)throw new Error('Fixture setup did not roundtrip.');
  const literal=(value:string)=>"[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('"+Buffer.from(value).toString('base64')+"'))";
  return "$ErrorActionPreference='Stop'\n"+definitions+String.raw`
class ArcaneOwnerFixtureRefusal : System.Exception { ArcaneOwnerFixtureRefusal() : base('Expected metadata policy refusal') {} }
`+'$reset=[ScriptBlock]::Create('+literal(reset)+')\n$policies=@{current=[ScriptBlock]::Create('+literal(ownerPolicyRefusalSeam(current))+');previous=[ScriptBlock]::Create('+literal(ownerPolicyRefusalSeam(previous))+')}\n'+String.raw`
$inputStream=[Console]::In;$outputStream=[Console]::Out;$errorStream=[Console]::Error
$outputStream.WriteLine('{"version":1,"ready":true}');$outputStream.Flush()
$lastId=0
while($null -ne ($line=$inputStream.ReadLine())){
  if($line.Length -gt 4096){throw 'fixture-frame-bound'}
  $request=$nativeJson.DeserializeObject($line)
  if($request.Count -ne 3 -or -not $request.ContainsKey('id') -or -not $request.ContainsKey('policy') -or -not $request.ContainsKey('value') -or
      $request.id -isnot [int] -or $request.id -ne $lastId+1 -or $request.id -gt 64 -or $request.policy -notin @('current','previous')){throw 'fixture-frame'}
  $lastId=$request.id
  $env:ARCANE_OWNER_FIXTURE_CASE=$nativeJson.Serialize($request.value)
  $env:ARCANE_WORKFLOW_ACL_ROOT='C:\arcane-owner-fixture'
  $env:ARCANE_WORKFLOW_ACL_PREPARE=if($request.value.existing){'0'}else{'1'}
  $env:ARCANE_WORKFLOW_ACL_KEY=if($request.value.existing){'1'}else{'0'}
  $capturedOut=[IO.StringWriter]::new();$capturedError=[IO.StringWriter]::new();$status=0
  try{
    [Console]::SetOut($capturedOut);[Console]::SetError($capturedError)
    [ArcaneOwnerFixtureState]::Identities=0;[ArcaneOwnerFixtureState]::Creates=0;[ArcaneOwnerFixtureState]::Writes=0
    . $reset
    try { & $policies[$request.policy] } catch [ArcaneOwnerFixtureRefusal] { $status=1 }
    finally {
      [Console]::Error.WriteLine('OWNER_POLICY_METADATA_DOUBLE '+$nativeJson.Serialize(@{identities=[ArcaneOwnerFixtureState]::Identities;creates=[ArcaneOwnerFixtureState]::Creates;writes=[ArcaneOwnerFixtureState]::Writes;directoryOwnerIsUser=([ArcaneOwnerFixtureState]::DirectoryAcl.GetOwner([Security.Principal.SecurityIdentifier]).Value -eq [ArcaneOwnerFixtureState]::User.Value);directoryProtected=[ArcaneOwnerFixtureState]::DirectoryAcl.AreAccessRulesProtected;directoryUnchanged=([ArcaneOwnerFixtureState]::DirectoryAcl.GetSecurityDescriptorSddlForm($sections) -ceq $beforeDirectory);keyUnchanged=([ArcaneOwnerFixtureState]::KeyAcl.GetSecurityDescriptorSddlForm($sections) -ceq $beforeKey)}))
    }
  } finally { [Console]::SetOut($outputStream);[Console]::SetError($errorStream) }
  $response=$nativeJson.Serialize(@{version=1;id=$lastId;status=$status;stdout=$capturedOut.ToString();stderr=$capturedError.ToString()})
  $capturedOut.Dispose();$capturedError.Dispose()
  if([Text.Encoding]::UTF8.GetByteCount($response) -gt 16384){throw 'fixture-response-bound'}
  $outputStream.WriteLine($response);$outputStream.Flush()
}
`;
}
export async function createOwnerPolicyHost(current:string,previous:string) {
  if(process.platform!=='win32')throw new Error('Owner-policy host requires Windows.');
  const windows=process.env.SystemRoot??'C:\\Windows',executable=join(windows,'System32','WindowsPowerShell','v1.0','powershell.exe');
  if(!/^[A-Za-z]:\\Windows$/i.test(windows))throw new Error('Invalid native Windows host.');
  const stat=lstatSync(executable);
  if(!stat.isFile()||stat.isSymbolicLink()||realpathSync.native(executable).toLowerCase()!==executable.toLowerCase())throw new Error('Invalid native Windows host.');
  const script=ownerPolicyHostScript(current,previous);
  if(Buffer.byteLength(script)>65536)throw new Error('Owner-policy host script exceeded its bound.');
  // A regular owned script avoids CreateProcess's command-line limit. It is
  // fixed before launch; request frames contain scenario data, never scripts.
  const directory=mkdtempSync(join(realpathSync.native(tmpdir()),'arcane-owner-policy-')),path=join(directory,'host.ps1');
  writeFileSync(path,script,{flag:'wx',mode:0o600});const pin=lstatSync(path,{bigint:true});
  const check=()=>{
    const now=lstatSync(path,{bigint:true});
    if(!now.isFile()||now.isSymbolicLink()||now.nlink!==1n||['dev','ino','size','mtimeNs','ctimeNs'].some(k=>now[k as keyof typeof now]!==pin[k as keyof typeof pin])||
        lstatSync(directory).isSymbolicLink()||realpathSync.native(directory).toLowerCase()!==directory.toLowerCase()||
        realpathSync.native(path).toLowerCase()!==path.toLowerCase()||readFileSync(path,'utf8')!==script)throw new Error('Owner-policy host script changed.');
  };
  const cleanup=()=>{check();unlinkSync(path);rmdirSync(directory);};
  check();
  let child:ReturnType<typeof childProcess.spawn>;
  try { child=childProcess.spawn(executable,['-NoLogo','-NoProfile','-NonInteractive','-File',path],{
    env:{...process.env,PSModulePath:join(windows,'System32','WindowsPowerShell','v1.0','Modules')},shell:false,windowsHide:true,stdio:['pipe','pipe','pipe'],
  }); } catch(error) {cleanup();throw error;}
  let pending:{accept:(value:unknown)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}|null=null;
  let failure:Error|null=null,buffer='',stderrBytes=0,sequence=0,ended=false;
  const closed=new Promise<{code:number|null;signal:NodeJS.Signals|null}>((accept,reject)=>child.once('close',(code,signal)=>{
    ended=true;if(pending)fail(new Error('Owner-policy host closed before its response.'));
    try{cleanup();accept({code,signal});}catch(error){reject(error);}
  }));
  function fail(error:Error) {
    failure??=error;
    if(pending){clearTimeout(pending.timer);const selected=pending;pending=null;selected.reject(error);}
    if(!ended)child.kill();
  }
  function response(deadline:number):Promise<unknown> {
    if(failure)throw failure;if(ended||pending)throw new Error('Owner-policy host is unavailable or busy.');
    return new Promise((accept,reject)=>{pending={accept,reject,timer:setTimeout(()=>fail(new Error('Owner-policy host deadline exceeded.')),deadline)};});
  }
  child.on('error',fail);child.stdin!.on('error',fail);child.stdout!.on('error',fail);child.stderr!.on('error',fail);child.stdout!.setEncoding('utf8');
  child.stderr!.on('data',(data:Buffer)=>{stderrBytes+=data.length;if(stderrBytes>16384)fail(new Error('Owner-policy host stderr exceeded its bound.'));});
  child.stdout!.on('data',(data:string)=>{
    buffer+=data;if(Buffer.byteLength(buffer)>16384){fail(new Error('Owner-policy host frame exceeded its bound.'));return;}
    const at=buffer.indexOf('\n');if(at<0)return;
    const line=buffer.slice(0,at);buffer=buffer.slice(at+1);
    if(!pending||buffer.trim()){fail(new Error('Unsolicited owner-policy response.'));return;}
    let value:unknown;try{value=JSON.parse(line);}catch{fail(new Error('Invalid owner-policy JSON.'));return;}
    const selected=pending;pending=null;clearTimeout(selected.timer);selected.accept(value);
  });
  async function close() {
    if(!ended)child.stdin!.end();
    let timer:ReturnType<typeof setTimeout>|undefined;
    try{return await Promise.race([closed,new Promise<never>((_,reject)=>{timer=setTimeout(()=>{if(!ended)child.kill();reject(new Error('Owner-policy host closure was not confirmed.'));},OWNER_POLICY_HOST_MS);})]);}
    finally{clearTimeout(timer);}
  }
  try {
    const ready=await response(OWNER_POLICY_HOST_MS);
    if(!ready||typeof ready!=='object'||Object.keys(ready).sort().join(',')!=='ready,version'||(ready as {ready?:unknown}).ready!==true||(ready as {version?:unknown}).version!==1)
      throw new Error('Invalid owner-policy host readiness.');
  } catch(error){fail(error instanceof Error?error:new Error('Owner-policy host failed.'));await close();throw error;}
  return Object.freeze({pid:child.pid,
    async run(value:OwnerPolicyCase,policy:'current'|'previous'='current'):Promise<OwnerPolicyResult> {
      ownerCase(value);if(policy!=='current'&&policy!=='previous'||sequence>=64)throw new Error('Invalid owner-policy request.');
      if(failure)throw failure;if(ended||pending)throw new Error('Owner-policy host is unavailable or busy.');
      const id=++sequence,line=JSON.stringify({id,policy,value});if(Buffer.byteLength(line)>4096)throw new Error('Owner-policy request exceeded its bound.');
      const reply=response(OWNER_POLICY_QUERY_MS);child.stdin!.write(line+'\n');
      try{return decodeOwnerPolicyResult(await reply,id);}catch(error){fail(error instanceof Error?error:new Error('Owner-policy host failed.'));throw error;}
    },close});
}
