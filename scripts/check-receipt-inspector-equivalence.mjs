/** Read-only comparison gate: no production edits, permission repairs or provider/Studio calls. */
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, renameSync, unlinkSync, rmSync, rmdirSync, symlinkSync, lstatSync, realpathSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute, sep } from 'node:path';
import { workflowReceiptParent } from '../dist/apps/daemon/src/workflow-host.js';
import { workflowProjectIdentity } from '../dist/packages/storage/src/workflow-store.js';

function inspectionOnlyTransform(script, inverse = false) {
  const before=String.raw`  function Direct([string]$path) {
    $item=Get-Item -LiteralPath $path -Force
    if(($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'link'}
    return $item
  }
  function Acl([string]$path) { return (Get-Acl -LiteralPath $path) }`;
  const after=String.raw`  function Direct([string]$path) {
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
  }`;
  const original = script; const input = inverse ? after : before, output = inverse ? before : after;
  assert.ok(original.includes(input)); let result=original.replace(input,output);
  for(const [a,b] of [
    ["if(-not $item.PSIsContainer){throw 'ancestor'}","if(-not (IsDirectory $item)){throw 'ancestor'}"],
    ['if(-not $item.PSIsContainer -or $prior.GetOwner','if(-not (IsDirectory $item) -or $prior.GetOwner'],
    ['if(-not $item.PSIsContainer -or -not $acl.AreAccessRulesProtected','if(-not (IsDirectory $item) -or -not $acl.AreAccessRulesProtected'],
    ['if($item.PSIsContainer -or $item.Length -ne 32','if((IsDirectory $item) -or $item.Length -ne 32'],
  ]) { const input=inverse?b:a,output=inverse?a:b; assert.ok(result.includes(input)); result=result.replace(input,output); }
  assert.ok(inverse ? !result.includes('function IsDirectory') : !result.includes('PSIsContainer'));
  if (inverse) return result;
  // Preparation and narrowing DACL writes remain byte-for-byte original.
  for(const needle of ["$danger=",'$allowed=@',"$dir=[IO.Path]::Combine",'Set-Acl -LiteralPath $dir -AclObject $acl','@(Get-ChildItem -LiteralPath $dir -Force).Count -ne 0']) {
    const line=s=>s.split('\n').find(x=>x.includes(needle)).replace('if(-not (IsDirectory $item) -or $prior.GetOwner','if(-not $item.PSIsContainer -or $prior.GetOwner');assert.equal(line(result),line(original));
  }
  return result;
}

export const inspectionOnlyCandidate = script => inspectionOnlyTransform(script);
export const inspectionOnlyLegacy = script => inspectionOnlyTransform(script, true);

async function main() {
  assert.equal(process.platform,'win32');assert.equal(process.argv.length,2);
  const modulePath=resolve('apps/daemon/src/workflow-private-storage.ts');
  const source=readFileSync(modulePath,'utf8').replaceAll('\r\n','\n');
  const marker='const SCRIPT=String.raw`';const start=source.indexOf(marker)+marker.length;const end=source.indexOf('\n`;',start);
  assert.ok(start>=marker.length && end>start);const current=source.slice(start,end)+'\n';const original=current.includes('function IsDirectory')?inspectionOnlyLegacy(current):current;const candidate=inspectionOnlyCandidate(original);
  assert.ok(current===original||current===candidate,'only the verified read-inspector replacement is supported');
  assert.equal(inspectionOnlyLegacy(candidate),original,'all non-inspection predicates and preparation writes must roundtrip exactly');
  const hash=value=>createHash('sha256').update(value).digest('hex');
  const evidence=mkdtempSync(join(resolve('runtime/verification'),'acl-equivalence-'));
  writeFileSync(join(evidence,'original.ps1'),original,{flag:'wx',mode:0o600});
  writeFileSync(join(evidence,'inspection-candidate.ps1'),candidate,{flag:'wx',mode:0o600});
  const root=mkdtempSync(join(tmpdir(),'arcane-acl-equivalence-'));const project=join(root,'project'),state=join(root,'state');mkdirSync(project);mkdirSync(state);
  const parent=workflowReceiptParent(state,workflowProjectIdentity(project).projectId),directory=join(parent,'workflow-human-receipts'),key=join(directory,'key-v1');
  const windows=process.env.SystemRoot??'C:\\Windows';const executable=join(windows,'System32/WindowsPowerShell/v1.0/powershell.exe');
  assert.equal(realpathSync(executable).toLowerCase(),resolve(executable).toLowerCase());assert.ok(lstatSync(executable).isFile());
  const checks=[]; let fingerprints=null; const timings=[];
  function run(script,prepare=false,withKey=true) {
    const started=performance.now();const result=spawnSync(executable,['-NoLogo','-NoProfile','-NonInteractive','-Command',script],{
      env:{...process.env,PSModulePath:join(windows,'System32/WindowsPowerShell/v1.0/Modules'),ARCANE_WORKFLOW_ACL_ROOT:parent,ARCANE_WORKFLOW_ACL_PREPARE:prepare?'1':'0',ARCANE_WORKFLOW_ACL_KEY:withKey?'1':'0'},
      shell:false,windowsHide:true,timeout:5000,maxBuffer:16384,encoding:'utf8',stdio:['ignore','pipe','pipe'],
    });
    return {status:result.status,signal:result.signal,error:result.error?.code??null,stdout:result.stdout?.trim()??'',elapsedMs:Math.round(performance.now()-started)};
  }
  function pair(name,expect) {
    const a=run(original),b=run(candidate);assert.equal(a.error,null,name+' original process');assert.equal(b.error,null,name+' candidate process');
    assert.equal(a.signal,null);assert.equal(b.signal,null);assert.equal(a.status,expect,name+' original');assert.equal(b.status,expect,name+' candidate');
    assert.equal(a.stdout,b.stdout,name+' exact descriptor');checks.push({name,original:a,candidate:b});
  }
  const fingerprintScript=String.raw`
$ErrorActionPreference='Stop'
$at=$env:ARCANE_WORKFLOW_ACL_ROOT
$paths=@()
while($at){$paths+=,$at;$p=[IO.Directory]::GetParent($at);if($null -eq $p){break};$at=$p.FullName}
$paths+=,[IO.Path]::Combine($env:ARCANE_WORKFLOW_ACL_ROOT,'workflow-human-receipts')
$paths+=,[IO.Path]::Combine($env:ARCANE_WORKFLOW_ACL_ROOT,'workflow-human-receipts','key-v1')
$rows=@()
foreach($path in $paths){
  $a=Get-Item -LiteralPath $path -Force
  $attributes=[IO.File]::GetAttributes($path)
  $directory=($attributes -band [IO.FileAttributes]::Directory) -ne 0
  if($directory){$b=[IO.DirectoryInfo]::new($path);$ba=[IO.Directory]::GetAccessControl($path)}else{$b=[IO.FileInfo]::new($path);$ba=[IO.File]::GetAccessControl($path)}
  $b.Refresh();$aa=Get-Acl -LiteralPath $path
  if($a.Attributes -ne $attributes -or $a.Attributes -ne $b.Attributes -or $a.PSIsContainer -ne $directory){throw 'attribute equivalence'}
  if(-not $directory -and $a.Length -ne $b.Length){throw 'length equivalence'}
  $sections=[Security.AccessControl.AccessControlSections]::Access -bor [Security.AccessControl.AccessControlSections]::Owner -bor [Security.AccessControl.AccessControlSections]::Group
  $x=$aa.GetSecurityDescriptorSddlForm($sections);$y=$ba.GetSecurityDescriptorSddlForm($sections)
  if($x -cne $y -or $aa.AreAccessRulesProtected -ne $ba.AreAccessRulesProtected -or $aa.GetOwner([Security.Principal.SecurityIdentifier]).Value -cne $ba.GetOwner([Security.Principal.SecurityIdentifier]).Value){throw 'ACL equivalence'}
  $left=@($aa.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]) | ForEach-Object {$_.IdentityReference.Value+'|'+$_.AccessControlType+'|'+$_.FileSystemRights+'|'+$_.InheritanceFlags+'|'+$_.PropagationFlags+'|'+$_.IsInherited})
  $right=@($ba.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]) | ForEach-Object {$_.IdentityReference.Value+'|'+$_.AccessControlType+'|'+$_.FileSystemRights+'|'+$_.InheritanceFlags+'|'+$_.PropagationFlags+'|'+$_.IsInherited})
  if(($left -join ';') -cne ($right -join ';')){throw 'rule equivalence'}
  $rows+=,@{attributesEqual=$true;aclEqual=$true;ownerEqual=$true;rulesEqual=$true;protectedEqual=$true;directory=$directory;ruleCount=$left.Count}
}
@{checked=$rows.Count;rows=$rows} | ConvertTo-Json -Compress -Depth 5
`;
  let passed=false;
  try {
    const prepare=run(original,true,false);assert.equal(prepare.status,0,'original checker must prepare this fresh empty owned child');
    writeFileSync(key,randomBytes(32),{flag:'wx',mode:0o600});
    pair('valid-private-key',0);
    const fp=run(fingerprintScript);assert.equal(fp.error,null);assert.equal(fp.status,0, 'native fingerprints must match');fingerprints=JSON.parse(fp.stdout);assert.ok(fingerprints.checked>=4);
    unlinkSync(key);pair('missing-key',1);
    writeFileSync(key,Buffer.alloc(31),{flag:'wx',mode:0o600});pair('31-byte-key',1);
    writeFileSync(key,Buffer.alloc(33));pair('33-byte-key',1);
    unlinkSync(key);mkdirSync(key);pair('directory-instead-of-key',1);rmdirSync(key);writeFileSync(key,randomBytes(32),{flag:'wx',mode:0o600});
    const saved=join(parent,'original-private-child');renameSync(directory,saved);const linkTarget=join(root,'junction-target');mkdirSync(linkTarget);symlinkSync(linkTarget,directory,'junction');
    pair('reparse-private-directory',1);unlinkSync(directory);renameSync(saved,directory);
    // Missing private storage without prepare is refused, never repaired.
    renameSync(directory,saved);pair('missing-private-directory',1);renameSync(saved,directory);
    for(let i=0;i<6;i++){const a=run(original),b=run(candidate);assert.equal(a.status,0);assert.equal(b.status,0);assert.equal(a.error,null);assert.equal(b.error,null);timings.push({originalMs:a.elapsedMs,candidateMs:b.elapsedMs});}
    assert.equal(hash(readFileSync(modulePath,'utf8').replaceAll('\r\n','\n')),hash(source),'production module must remain unchanged during the comparison');passed=true;
  } finally {
    const proof={schemaVersion:1,kind:'real-windows-read-only-inspector-equivalence',passed,productionEdited:false,securityRulesChanged:false,securityDeadlineMs:5000,originalScriptSha256:hash(original),candidateScriptSha256:hash(candidate),fingerprints,checks,timings,providerInference:false,studioOperations:0,fullProductVerified:false};
    writeFileSync(join(evidence,'verification.json'),JSON.stringify(proof,null,2)+'\n',{flag:'wx',mode:0o600});
    const base=resolve(homedir(),'.arcane-private-receipts-v1'),part=relative(base,resolve(parent));assert.match(part,/^[a-f0-9]{64}$/);assert.ok(!lstatSync(parent).isSymbolicLink());assert.equal(realpathSync(parent).toLowerCase(),resolve(parent).toLowerCase());rmSync(parent,{recursive:true,force:true});
    const part2=relative(resolve(tmpdir()),resolve(root));assert.ok(part2&&!isAbsolute(part2)&&part2!=='..'&&!part2.startsWith('..'+sep));rmSync(root,{recursive:true,force:true});
    console.log(JSON.stringify({evidence,passed,cases:checks.length,fingerprints: fingerprints?.checked??0,timings}));
  }
}
if(process.argv[1]&&resolve(process.argv[1])===resolve(fileURLToPath(import.meta.url)))await main();
