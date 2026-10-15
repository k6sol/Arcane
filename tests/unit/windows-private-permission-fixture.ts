import childProcess from 'node:child_process';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import type test from 'node:test';

const errorCode = (error: Error | undefined) => (error as NodeJS.ErrnoException | undefined)?.code ?? null;

// Use the Windows .NET Framework serializer directly: JSON cmdlets can trigger
// module discovery in the very cold-start diagnostics we need to observe.
export const nativeMetadataJsonSetup = String.raw`
$PSModuleAutoLoadingPreference='None'
$null=[Reflection.Assembly]::Load('System.Web.Extensions, Version=4.0.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35')
$nativeJson=[Web.Script.Serialization.JavaScriptSerializer]::new()
$nativeJson.MaxJsonLength=8192
$nativeJson.RecursionLimit=8
`;

// Diagnostic evidence only. This script cannot create, repair, open key bytes,
// change a token, or return a descriptor that grants production authority.
export const privatePermissionTraceScript = String.raw`
$ErrorActionPreference='Stop'
try {
` + nativeMetadataJsonSetup + String.raw`
  $root=$env:ARCANE_WORKFLOW_ACL_ROOT
  if([string]::IsNullOrEmpty($root) -or $root.Length -gt 4096 -or $root.StartsWith('\') -or -not [IO.Path]::IsPathRooted($root)){throw 'scope'}
  $identity=[Security.Principal.WindowsIdentity]::GetCurrent()
  $user=$identity.User.Value
  $defaultOwner=$identity.Owner.Value
  $allowed=@($user,'S-1-5-18','S-1-5-32-544')
  $danger=[Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor [Security.AccessControl.FileSystemRights]::Delete -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership
  function Row([string]$path) {
    try {
      $attributes=[IO.File]::GetAttributes($path)
      $directory=($attributes -band [IO.FileAttributes]::Directory) -ne 0
      $reparse=($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0
      if($reparse){return @{exists=$true;directory=$directory;reparse=$true}}
      if($directory){$acl=[IO.Directory]::GetAccessControl($path)}else{$acl=[IO.File]::GetAccessControl($path)}
      $owner=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
      $rules=$acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])
      if($rules.Count -gt 256){throw 'rule-budget'}
      $dangerous=0;$foreign=0
      foreach($rule in $rules){
        if($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and $allowed -notcontains $rule.IdentityReference.Value){
          $foreign++
          if(($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -eq 0 -and ($rule.FileSystemRights -band $danger) -ne 0){$dangerous++}
        }
      }
      $row=@{exists=$true;directory=$directory;reparse=$false;ownerIsUser=($owner -eq $user);ownerIsTokenDefault=($owner -eq $defaultOwner);ownerIsAdministrators=($owner -eq 'S-1-5-32-544');ownerIsSystem=($owner -eq 'S-1-5-18');protected=$acl.AreAccessRulesProtected;ruleCount=$rules.Count;foreignAllowCount=$foreign;dangerousAllowCount=$dangerous}
      if($directory){
        $entries=[IO.Directory]::EnumerateFileSystemEntries($path).GetEnumerator()
        try{$row.empty=-not $entries.MoveNext()}finally{if($entries -is [IDisposable]){$entries.Dispose()}}
      }else{$row.length=([IO.FileInfo]::new($path)).Length}
      return $row
    }catch [IO.FileNotFoundException]{return @{exists=$false}}catch [IO.DirectoryNotFoundException]{return @{exists=$false}}catch{return @{errorType=$_.Exception.GetType().FullName}}
  }
  $ancestors=@();$at=$root
  while($at){
    if($ancestors.Count -ge 32){throw 'ancestor-budget'}
    $row=Row $at;$ancestors+=,$row
    if($row.reparse -or $row.errorType -or -not $row.exists){break}
    $parent=[IO.Directory]::GetParent($at)
    if($null -eq $parent){break};$at=$parent.FullName
  }
  $dir=[IO.Path]::Combine($root,'workflow-human-receipts')
  $directory=Row $dir
  $key=@{exists=$false}
  if($directory.exists -and -not $directory.reparse -and -not $directory.errorType){$key=Row ([IO.Path]::Combine($dir,'key-v1'))}
  $report=@{version=1;powerShell=$PSVersionTable.PSVersion.ToString();tokenOwnerIsUser=($defaultOwner -eq $user);tokenOwnerIsAdministrators=($defaultOwner -eq 'S-1-5-32-544');tokenOwnerIsSystem=($defaultOwner -eq 'S-1-5-18');fullPathMatches=([IO.Path]::GetFullPath($root) -ceq $root);ancestors=$ancestors;directory=$directory;key=$key}
  [Console]::Write($nativeJson.Serialize($report))
}catch{[Console]::Error.WriteLine('Arcane permission trace unavailable.');exit 1}
`;

export function tracePrivatePermissions(parent: string) {
  const windows = process.env.SystemRoot ?? 'C:\\Windows';
  const executable = join(windows, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const result = childProcess.spawnSync(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', privatePermissionTraceScript], {
    env: { ...process.env, PSModulePath: join(windows, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules'), ARCANE_WORKFLOW_ACL_ROOT: parent },
    shell: false, windowsHide: true, timeout: 5_000, maxBuffer: 16_384, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  let report: unknown = null;
  if (!result.error && result.status === 0 && !result.signal && Buffer.byteLength(result.stdout) <= 8_192) {
    try { report = JSON.parse(result.stdout); } catch { /* Evidence is unavailable; never grant authority. */ }
  }
  return { status: result.status, signal: result.signal, errorCode: errorCode(result.error), report };
}

/** Forward every native call unchanged; on the first refusal, only read metadata.
 * The original failed result still reaches production and still fails the test.
 */
export function observePrivatePermissionRefusal(t: test.TestContext, parent: string): () => void {
  const original = childProcess.spawnSync;
  const executable = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  let traced = false;
  const canonical = (path: string) => {
    try { return !lstatSync(path).isSymbolicLink() && realpathSync.native(path).toLowerCase() === path.toLowerCase(); }
    catch { return false; }
  };
  const observation = t.mock.method(childProcess, 'spawnSync', (command: string, args: readonly string[], options: childProcess.SpawnSyncOptionsWithStringEncoding) => {
    const selected = command === executable && options.env?.ARCANE_WORKFLOW_ACL_ROOT === parent && args.length === 5 &&
      args.slice(0, 4).join('|') === '-NoLogo|-NoProfile|-NonInteractive|-Command' && args[4] !== privatePermissionTraceScript;
    const directoryExistedBefore = selected && existsSync(join(parent, 'workflow-human-receipts'));
    const started = performance.now();
    const result = original(command, args, options);
    if (selected && !traced && (result.error || result.status !== 0 || result.signal)) {
      traced = true;
      t.diagnostic('WORKFLOW_PRIVATE_PERMISSION_TRACE ' + JSON.stringify({
        version: 1, productionCallUnchanged: true, prepare: options.env?.ARCANE_WORKFLOW_ACL_PREPARE,
        key: options.env?.ARCANE_WORKFLOW_ACL_KEY, directoryExistedBefore, rootCanonicalNative: canonical(parent),
        executableCanonicalNative: canonical(executable), elapsedMs: Math.round(performance.now() - started),
        original: { status: result.status, signal: result.signal, errorCode: errorCode(result.error) },
        trace: tracePrivatePermissions(parent),
      }));
    }
    return result;
  });
  syncBuiltinESMExports();
  let closed = false;
  const close = () => { if (!closed) { closed = true; observation.mock.restore(); syncBuiltinESMExports(); } };
  t.after(close);
  return close;
}
