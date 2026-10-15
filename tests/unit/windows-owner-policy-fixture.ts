import childProcess from 'node:child_process';
import {lstatSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
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
 * Every actual policy case still gets a fresh process and its original 5s cap. */
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
