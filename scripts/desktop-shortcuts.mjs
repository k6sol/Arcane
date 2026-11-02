import {dirname,join} from 'node:path';
import {createWindowsInstallation} from './windows-installation.mjs';
import {runBoundedChild} from './check-windows-executable.mjs';

// Kept separate so native tests can exercise the same implementation in owned
// fixture directories without touching the person's Desktop or Start Menu.
export const shortcutFunctions=String.raw`
function Set-ArcaneShortcuts($target,$allowed,$directories) {
  $shell=New-Object -ComObject WScript.Shell
  $plans=@()
  foreach($directory in $directories){
    if(-not $directory -or -not [IO.Directory]::Exists($directory)){throw 'Shortcut directory unavailable.'}
    $path=Join-Path $directory 'Arcane.lnk'
    $hash=$null
    if(Test-Path -LiteralPath $path){
      $item=Get-Item -LiteralPath $path -Force
      if($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $item.Length -gt 16384){throw 'Arcane shortcut needs review.'}
      $existing=$shell.CreateShortcut($path)
      if($existing.Arguments -or -not ($allowed -contains $existing.TargetPath)){throw 'An unrelated Arcane shortcut already exists.'}
      $hash=(Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash
    }
    $plans+=@{path=$path;directory=$directory;hash=$hash}
  }
  foreach($plan in $plans){
    $temporary=Join-Path $plan.directory ('.Arcane-'+[Guid]::NewGuid().ToString()+'.lnk')
    $shortcut=$shell.CreateShortcut($temporary)
    $shortcut.TargetPath=$target
    $shortcut.WorkingDirectory=[IO.Path]::GetDirectoryName($target)
    $shortcut.IconLocation=$target+',0'
    $shortcut.Description='Arcane'
    $shortcut.Save()
    $check=$shell.CreateShortcut($temporary)
    if($check.TargetPath -ne $target -or $check.Arguments -or $check.WorkingDirectory -ne [IO.Path]::GetDirectoryName($target)){throw 'Shortcut verification failed.'}
    if($null -ne $plan.hash){
      if((Get-FileHash -LiteralPath $plan.path -Algorithm SHA256).Hash -ne $plan.hash){throw 'Arcane shortcut changed during update.'}
      [IO.File]::Replace($temporary,$plan.path,[NullString]::Value)
    }else{[IO.File]::Move($temporary,$plan.path)}
    $saved=$shell.CreateShortcut($plan.path)
    if($saved.TargetPath -ne $target -or $saved.Arguments){throw 'Saved shortcut did not match the stable launcher.'}
  }
}
`;

const program=String.raw`
$ErrorActionPreference='Stop'
`+shortcutFunctions+String.raw`
$desktop=[Environment]::GetFolderPath('Desktop')
$programs=[Environment]::GetFolderPath('Programs')
$allowed=ConvertFrom-Json $env:ARCANE_SHORTCUT_TARGETS
Set-ArcaneShortcuts $env:ARCANE_DESKTOP_LAUNCHER $allowed @($desktop,$programs)
Write-Output (Join-Path $desktop 'Arcane.lnk')
`;

/** Keep one fixed app entry per Windows location, always targeting the stable
 * launcher. A legacy link is migrated only from this installation's recorded
 * release executables; arbitrary Arcane-named links are retained. */
export async function createDesktopShortcuts(launcher,{installation=createWindowsInstallation(),run=runBoundedChild}={}){
  const root=dirname(launcher),status=await installation.status(root);
  if(join(status.root,'Arcane.exe')!==launcher)throw Error('Expected the stable Arcane launcher.');
  const allowed=[launcher,...status.releases.map(release=>join(root,'releases',release.id,'Arcane.exe'))];
  const executable=join(process.env.SystemRoot??'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
  const result=await run(executable,['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(program,'utf16le').toString('base64')],
    {cwd:root,env:{SystemRoot:process.env.SystemRoot,USERPROFILE:process.env.USERPROFILE,APPDATA:process.env.APPDATA,LOCALAPPDATA:process.env.LOCALAPPDATA,
      ARCANE_DESKTOP_LAUNCHER:launcher,ARCANE_SHORTCUT_TARGETS:JSON.stringify(allowed)},deadlineMs:30000});
  if(result.code!==0)throw Error('The app is installed, but its Windows shortcuts need review. '+result.output.slice(0,1000));
  return result.output.trim();
}
