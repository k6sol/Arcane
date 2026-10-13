import { spawnSync } from 'node:child_process';
import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { ArcaneError } from '../../../packages/protocol/src/providers.js';

export interface PrivateReceiptDescriptor { version: 1; created: boolean; directoryPrivate: true; keyPrivate: boolean; ancestorsSafe: true }
function fail(): never { throw new ArcaneError('WORKFLOW_RECEIPT_STORAGE', 'Workflow approvals require verified private Arcane storage. Existing permissions and keys were not repaired or replaced.'); }
export function parsePrivateReceiptDescriptor(value: unknown, prepare: boolean, key: boolean): PrivateReceiptDescriptor {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail();
  const a=value as Record<string,unknown>;
  if (Object.keys(a).length!==5 || ['version','created','directoryPrivate','keyPrivate','ancestorsSafe'].some(k=>!Object.hasOwn(a,k))) fail();
  for (const k of Object.keys(a)) { const d=Object.getOwnPropertyDescriptor(a,k); if(!d||!Object.hasOwn(d,'value'))fail(); }
  if(a.version!==1||typeof a.created!=='boolean'||a.directoryPrivate!==true||a.keyPrivate!==key||a.ancestorsSafe!==true||(!prepare&&a.created))fail();
  return a as unknown as PrivateReceiptDescriptor;
}

// Fixed native ACL operation. Neither source code nor a command/executable path
// comes from workflow text, HTTP JSON, an MCP tool, or provider configuration.
// Read-only .NET inspection avoids filesystem-provider discovery; verified
// against native attributes, owner/DACL/rules and rejection cases. The native
// binary, complete predicates, preparation writes and 5000ms deadline are unchanged.
// Only a new, empty, direct Arcane child receives a narrower DACL. An existing
// directory is inspected, never "repaired". No ACL elsewhere is changed.
const SCRIPT=String.raw`
$ErrorActionPreference='Stop'
try {
  $root=$env:ARCANE_WORKFLOW_ACL_ROOT
  $prepare=$env:ARCANE_WORKFLOW_ACL_PREPARE -eq '1'
  $key=$env:ARCANE_WORKFLOW_ACL_KEY -eq '1'
  if([string]::IsNullOrEmpty($root) -or $root.Length -gt 4096 -or $root -match '[\x00-\x1f]' -or $root.StartsWith('\') -or -not [IO.Path]::IsPathRooted($root)){throw 'scope'}
  $full=[IO.Path]::GetFullPath($root)
  if($full -cne $root -or -not [IO.Directory]::Exists($root)){throw 'scope'}
  $user=[Security.Principal.WindowsIdentity]::GetCurrent().User
  $allowed=@($user.Value,'S-1-5-18','S-1-5-32-544')
  $danger=[Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor [Security.AccessControl.FileSystemRights]::Delete -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership
  function Direct([string]$path) {
    $attributes=[IO.File]::GetAttributes($path)
    if(($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'link'}
    if(($attributes -band [IO.FileAttributes]::Directory) -ne 0){
      $item=[IO.DirectoryInfo]::new($path)
    } else { $item=[IO.FileInfo]::new($path) }
    $item.Refresh()
    return $item
  }
  function IsDirectory($item) { return (($item.Attributes -band [IO.FileAttributes]::Directory) -ne 0) }
  function Acl([string]$path) {
    if(([IO.File]::GetAttributes($path) -band [IO.FileAttributes]::Directory) -ne 0){
      return [IO.Directory]::GetAccessControl($path)
    }
    return [IO.File]::GetAccessControl($path)
  }
  function Rules($acl) { return $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]) }
  $at=$root
  while($at){
    $item=Direct $at
    if(-not (IsDirectory $item)){throw 'ancestor'}
    foreach($rule in (Rules (Acl $at))){
      if($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and ($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -eq 0 -and $allowed -notcontains $rule.IdentityReference.Value -and ($rule.FileSystemRights -band $danger) -ne 0){throw 'ancestor-acl'}
    }
    $parent=[IO.Directory]::GetParent($at)
    if($null -eq $parent){break}
    $at=$parent.FullName
  }
  $dir=[IO.Path]::Combine($root,'workflow-human-receipts')
  $created=$false
  if(-not [IO.Directory]::Exists($dir)){
    if(-not $prepare -or [IO.File]::Exists($dir)){throw 'missing'}
    $info=[IO.Directory]::CreateDirectory($dir)
    $item=Direct $dir
    $prior=Acl $dir
    if(-not (IsDirectory $item) -or $prior.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $user.Value -or @(Get-ChildItem -LiteralPath $dir -Force).Count -ne 0){throw 'created-scope'}
    $acl=New-Object Security.AccessControl.DirectorySecurity
    $acl.SetOwner($user)
    $acl.SetAccessRuleProtection($true,$false)
    foreach($sid in $allowed){
      $principal=New-Object Security.Principal.SecurityIdentifier($sid)
      $rule=New-Object Security.AccessControl.FileSystemAccessRule($principal,[Security.AccessControl.FileSystemRights]::FullControl,([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit),[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow)
      $acl.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $dir -AclObject $acl
    $created=$true
  }
  $item=Direct $dir
  $acl=Acl $dir
  if(-not (IsDirectory $item) -or -not $acl.AreAccessRulesProtected -or $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $user.Value){throw 'private-dir'}
  foreach($rule in (Rules $acl)){if($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and $allowed -notcontains $rule.IdentityReference.Value){throw 'private-dir-rule'}}
  if($key){
    $file=[IO.Path]::Combine($dir,'key-v1')
    $item=Direct $file
    $acl=Acl $file
    if((IsDirectory $item) -or $item.Length -ne 32 -or $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $user.Value){throw 'private-key'}
    foreach($rule in (Rules $acl)){if($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and $allowed -notcontains $rule.IdentityReference.Value){throw 'private-key-rule'}}
  }
  [ordered]@{version=1;created=$created;directoryPrivate=$true;keyPrivate=$key;ancestorsSafe=$true} | ConvertTo-Json -Compress
} catch { [Console]::Error.WriteLine('Arcane private workflow storage unavailable.'); exit 1 }
`;

/** Host-only native check; never call with paths from a workflow or web request. */
export function privateWorkflowReceiptStorage(parent: string, prepare: boolean, key: boolean): PrivateReceiptDescriptor | null {
  if(process.platform!=='win32')return null;
  if(typeof parent!=='string'||!isAbsolute(parent)||parent.length>4096||Array.from(parent).some(c=>c.charCodeAt(0)<32||c.charCodeAt(0)===127)||parent.startsWith(String.fromCharCode(92,92))||parent.startsWith('//')||typeof prepare!=='boolean'||typeof key!=='boolean')fail();
  const root=resolve(parent);
  try { const s=lstatSync(root);if(!s.isDirectory()||s.isSymbolicLink()||realpathSync.native(root).toLowerCase()!==root.toLowerCase())fail(); } catch { fail(); }
  const windows=process.env.SystemRoot ?? ('C:'+String.fromCharCode(92)+'Windows');
  if(!/^[a-z]$/i.test(windows[0] ?? '')||windows.slice(1).toLowerCase()!==String.fromCharCode(58,92)+'windows')fail();
  const executable=join(windows,'System32','WindowsPowerShell','v1.0','powershell.exe');
  try {const s=lstatSync(executable);if(!s.isFile()||s.isSymbolicLink()||realpathSync.native(executable).toLowerCase()!==executable.toLowerCase())fail();}catch{fail();}
  const env={...process.env,PSModulePath:join(windows,'System32','WindowsPowerShell','v1.0','Modules'),ARCANE_WORKFLOW_ACL_ROOT:root,ARCANE_WORKFLOW_ACL_PREPARE:prepare?'1':'0',ARCANE_WORKFLOW_ACL_KEY:key?'1':'0'};
  const child=spawnSync(executable,['-NoLogo','-NoProfile','-NonInteractive','-Command',SCRIPT],{env,shell:false,windowsHide:true,encoding:'utf8',timeout:5000,maxBuffer:16384,stdio:['ignore','pipe','pipe']});
  if(child.error||child.status!==0||child.signal||Buffer.byteLength(child.stdout??'')>2048)fail();
  let value:unknown;try{value=JSON.parse(child.stdout.trim());}catch{fail();}
  return parsePrivateReceiptDescriptor(value,prepare,key);
}
