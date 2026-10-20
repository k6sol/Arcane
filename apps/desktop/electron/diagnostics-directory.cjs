'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {execFile}=require('node:child_process');
const ERROR='Arcane diagnostic storage is unavailable.';
const SCRIPT=String.raw`$ErrorActionPreference='Stop'
$PSModuleAutoLoadingPreference='None'
try {
  $root=$env:ARCANE_DIAGNOSTIC_ACL_ROOT
  $created=$env:ARCANE_DIAGNOSTIC_ACL_CREATED -eq '1'
  if([string]::IsNullOrEmpty($root) -or $root.Length -gt 4096 -or $root -match '[\x00-\x1f]' -or $root.StartsWith('\') -or -not [IO.Path]::IsPathRooted($root)){throw 'scope'}
  if([IO.Path]::GetFullPath($root) -cne $root -or -not [IO.Directory]::Exists($root)){throw 'scope'}
  $identity=[Security.Principal.WindowsIdentity]::GetCurrent()
  $user=$identity.User
  $defaultOwner=$identity.Owner
  if($null -eq $user -or $null -eq $defaultOwner){throw 'token-owner'}
  $allowed=@($user.Value,'S-1-5-18','S-1-5-32-544')
  if($allowed -notcontains $defaultOwner.Value){throw 'token-owner'}
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
  $dir=[IO.Path]::Combine($root,'diagnostics')
  $item=Direct $dir
  if(-not (IsDirectory $item)){throw 'private-dir'}
  if($created){
    $prior=Acl $dir
    if($prior.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin @($user.Value,$defaultOwner.Value)){throw 'created-scope'}
    $entries=[IO.Directory]::EnumerateFileSystemEntries($dir).GetEnumerator()
    try{$empty=-not $entries.MoveNext()}finally{if($entries -is [IDisposable]){$entries.Dispose()}}
    if(-not $empty){throw 'created-scope'}
    $acl=[Security.AccessControl.DirectorySecurity]::new()
    $acl.SetOwner($user)
    $acl.SetAccessRuleProtection($true,$false)
    foreach($sid in $allowed){
      $principal=[Security.Principal.SecurityIdentifier]::new($sid)
      $rule=[Security.AccessControl.FileSystemAccessRule]::new($principal,[Security.AccessControl.FileSystemRights]::FullControl,([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit),[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow)
      $acl.AddAccessRule($rule)
    }
    $item=Direct $dir
    if(-not (IsDirectory $item)){throw 'created-scope'}
    [IO.Directory]::SetAccessControl($dir,$acl)
  }
  $item=Direct $dir
  $acl=Acl $dir
  if(-not (IsDirectory $item) -or -not $acl.AreAccessRulesProtected -or $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $user.Value){throw 'private-dir'}
  foreach($rule in (Rules $acl)){if($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and $allowed -notcontains $rule.IdentityReference.Value){throw 'private-dir-rule'}}
  $createdJson=if($created){'true'}else{'false'}
  [Console]::Write('{"version":1,"created":'+$createdJson+',"directoryPrivate":true,"ancestorsSafe":true}')
} catch { [Console]::Error.WriteLine('Arcane diagnostic storage is unavailable.'); exit 1 }
`;
const refuse=()=>{throw Error(ERROR);};
const same=(a,b)=>a.toLowerCase()===b.toLowerCase();
const identity=(a,b)=>a.dev===b.dev&&a.ino===b.ino&&a.mode===b.mode;
function direct(filename,file=false){
 const before=fs.lstatSync(filename,{bigint:true});
 if(before.isSymbolicLink()||!(file?before.isFile():before.isDirectory())||!same(fs.realpathSync.native(filename),filename))refuse();
 const after=fs.lstatSync(filename,{bigint:true});if(!identity(before,after)||after.isSymbolicLink())refuse();return after;
}
/** Main-only fixed leaf. Existing permissions are inspected, never repaired. */
function createDiagnosticsDirectoryPreparer({root}){
 return async directory=>{
  try{
   if(process.platform!=='win32'||typeof root!=='string'||root.length>4096||!path.isAbsolute(root)||path.resolve(root)!==root||/^(?:\\|\/\/)/.test(root)||/[\x00-\x1f\x7f]/.test(root))refuse();
   const target=path.join(root,'diagnostics');if(typeof directory!=='string'||directory!==target)refuse();
   const parts=root.slice(path.parse(root).root.length).split(/[\\/]/);
   if(parts.some(p=>!p||p==='.'||p==='..'||/[<>:"|?*]|[. ]$/.test(p)||/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p)))refuse();
   const pins=new Map();for(let at=root;;at=path.dirname(at)){pins.set(at,direct(at));if(path.dirname(at)===at)break;}
   let created=false,pin;
   try{pin=direct(target);}catch(error){if(error.code!=='ENOENT')throw error;fs.mkdirSync(target,{mode:0o700});created=true;pin=direct(target);}
   const windows=process.env.SystemRoot??'C:\\Windows';if(!/^[a-z]:\\windows$/i.test(windows))refuse();
   const executable=path.join(windows,'System32','WindowsPowerShell','v1.0','powershell.exe'),executablePin=direct(executable,true);
   const check=()=>{for(const[name,before]of pins)if(!identity(before,direct(name)))refuse();if(!identity(pin,direct(target))||!identity(executablePin,direct(executable,true)))refuse();};
   check();
   const stdout=await new Promise((resolve,reject)=>{
    execFile(executable,['-NoLogo','-NoProfile','-NonInteractive','-Command',SCRIPT],{
     shell:false,windowsHide:true,encoding:'utf8',timeout:5000,maxBuffer:16384,
     env:{SystemRoot:windows,WINDIR:windows,PATH:path.join(windows,'System32'),PSModulePath:path.join(windows,'System32','WindowsPowerShell','v1.0','Modules'),ARCANE_DIAGNOSTIC_ACL_ROOT:root,ARCANE_DIAGNOSTIC_ACL_CREATED:created?'1':'0'},
    },(error,stdout)=>error?reject(error):resolve(stdout));
   });
   check();if(typeof stdout!=='string'||Buffer.byteLength(stdout)>2048)refuse();
   const result=JSON.parse(stdout.trim());
   if(!result||Object.getPrototypeOf(result)!==Object.prototype||Object.keys(result).sort().join(',')!=='ancestorsSafe,created,directoryPrivate,version'||result.version!==1||result.created!==created||result.directoryPrivate!==true||result.ancestorsSafe!==true)refuse();
   return target;
  }catch{refuse();}
 };
}
module.exports={createDiagnosticsDirectoryPreparer};
