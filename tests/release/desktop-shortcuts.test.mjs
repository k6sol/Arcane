import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createDesktopShortcuts,shortcutFunctions} from '../../scripts/desktop-shortcuts.mjs';
import {runBoundedChild} from '../../scripts/check-windows-executable.mjs';

test('shortcut repair admits only the stable launcher and the same installation recorded releases',async()=>{
 const root=join(tmpdir(),'arcane-shortcut-contract'),launcher=join(root,'Arcane.exe');let calls=0;
 const result=await createDesktopShortcuts(launcher,{installation:{status:async observed=>{assert.equal(observed,root);return{root,releases:[{id:'recorded-release'}]};}},run:async(_command,args,options)=>{
  calls++;assert.ok(args.includes('-EncodedCommand'));assert.equal(options.env.ARCANE_DESKTOP_LAUNCHER,launcher);
  assert.match(Buffer.from(args.at(-1),'base64').toString('utf16le'),/\$allowed=ConvertFrom-Json \$env:ARCANE_SHORTCUT_TARGETS/);
  assert.deepEqual(JSON.parse(options.env.ARCANE_SHORTCUT_TARGETS),[launcher,join(root,'releases','recorded-release','Arcane.exe')]);
  return{code:0,output:'Desktop/Arcane.lnk\n'};
 }});
 assert.equal(result,'Desktop/Arcane.lnk');assert.equal(calls,1);
});

test('native shortcuts migrate old release targets in place and reject foreign links before any write',{skip:process.platform!=='win32'},async t=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'arcane-shortcuts-')));t.after(()=>rm(root,{recursive:true,force:true}));
 const script=String.raw`
$ErrorActionPreference='Stop'
`+shortcutFunctions+String.raw`
$root=$env:ARCANE_SHORTCUT_FIXTURE
$desktop=Join-Path $root 'Desktop';$programs=Join-Path $root 'Programs'
[IO.Directory]::CreateDirectory($desktop)|Out-Null
[IO.Directory]::CreateDirectory($programs)|Out-Null
$target=Join-Path $root 'Arcane.exe';$old=Join-Path $root 'old/Arcane.exe'
$shell=New-Object -ComObject WScript.Shell
$desktopLink=Join-Path $desktop 'Arcane.lnk';$programLink=Join-Path $programs 'Arcane.lnk'
foreach($path in @($desktopLink,$programLink)){$link=$shell.CreateShortcut($path);$link.TargetPath=$old;$link.Save()}
$allowed=ConvertFrom-Json (ConvertTo-Json -InputObject @($target,$old) -Compress)
if($allowed.Count -ne 2 -or -not ($allowed -contains $old)){throw 'Recorded target JSON did not preserve the flat target list.'}
Set-ArcaneShortcuts $target $allowed @($desktop,$programs)
Set-ArcaneShortcuts $target $allowed @($desktop,$programs)
foreach($path in @($desktopLink,$programLink)){
  $link=$shell.CreateShortcut($path)
  if($link.TargetPath -ne $target -or $link.Arguments){throw 'Stable target was not retained.'}
}
if(@(Get-ChildItem -LiteralPath $desktop,$programs -Filter '*.lnk').Count -ne 2){throw 'Duplicate shortcuts.'}
$link=$shell.CreateShortcut($programLink);$link.TargetPath=Join-Path $root 'unrelated.exe';$link.Save()
$beforeDesktop=(Get-FileHash -LiteralPath $desktopLink).Hash
$beforePrograms=(Get-FileHash -LiteralPath $programLink).Hash
$refused=$false
try{Set-ArcaneShortcuts $target @($target,$old) @($desktop,$programs)}catch{$refused=$true}
if(-not $refused -or (Get-FileHash -LiteralPath $desktopLink).Hash -ne $beforeDesktop -or (Get-FileHash -LiteralPath $programLink).Hash -ne $beforePrograms){throw 'Foreign link was not retained before all writes.'}
Write-Output 'stable-shortcuts-pass'
`;
 const result=await runBoundedChild(join(process.env.SystemRoot??'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{cwd:root,env:{...process.env,ARCANE_SHORTCUT_FIXTURE:root},deadlineMs:30000});
 assert.equal(result.code,0,result.output);assert.match(result.output,/stable-shortcuts-pass/);
});
