import {copyFile,readFile,writeFile,mkdir,mkdtemp,lstat,realpath} from 'node:fs/promises';
import {constants} from 'node:fs';
import {createHash} from 'node:crypto';
import {join,resolve,dirname,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
import policy from '../apps/desktop/electron/policy.cjs';
import updates from '../apps/desktop/electron/desktop-updates.cjs';
import {createWindowsInstallation} from './windows-installation.mjs';
import {runBoundedChild} from './check-windows-executable.mjs';
const repository=resolve(fileURLToPath(new URL('..',import.meta.url)));
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const launcherFiles=['installer/Launcher.cs','installer/InstalledRecord.cs','installer/OperationLease.cs','installer/PayloadArchive.cs','installer/launcher.manifest','apps/desktop/electron/icon.ico'];
const shortcutProgram=String.raw`
$ErrorActionPreference='Stop'
$desktop=[Environment]::GetFolderPath('Desktop')
if(-not $desktop){throw 'Desktop unavailable.'}
$target=$env:ARCANE_DESKTOP_LAUNCHER
$shortcutPath=Join-Path $desktop 'Arcane.lnk'
$shell=New-Object -ComObject WScript.Shell
if(Test-Path -LiteralPath $shortcutPath){
  $existing=$shell.CreateShortcut($shortcutPath)
  if($existing.TargetPath -ne $target -or $existing.Arguments){throw 'An unrelated Arcane shortcut already exists.'}
}
$temporary=Join-Path $desktop ('.Arcane-'+[Guid]::NewGuid().ToString()+'.lnk')
$shortcut=$shell.CreateShortcut($temporary)
$shortcut.TargetPath=$target
$shortcut.WorkingDirectory=[IO.Path]::GetDirectoryName($target)
$shortcut.IconLocation=$target+',0'
$shortcut.Description='Arcane'
$shortcut.Save()
Move-Item -LiteralPath $temporary -Destination $shortcutPath -Force
if(-not(Test-Path -LiteralPath $shortcutPath)){throw 'Desktop shortcut was not saved.'}
Write-Output $shortcutPath
`;
async function sourceDigest(root){const rows=[];for(const file of launcherFiles){await policy.directPath(join(root,file),'file');rows.push(file+':'+digest(await readFile(join(root,file))));}return digest(Buffer.from(rows.join('\n')));}
async function buildLauncher(root){
  if(process.platform!=='win32')throw Error('Build the desktop launcher on Windows.');
  const owner=await realpath(await mkdtemp(join(tmpdir(),'arcane-launcher-'))),output=join(owner,'Arcane.exe');
  const compiler=join(process.env.SystemRoot??'C:/Windows','Microsoft.NET/Framework64/v4.0.30319/csc.exe');
  const result=await runBoundedChild(compiler,['/nologo','/target:winexe','/platform:x64','/optimize+',
    '/main:Arcane.Installer.LauncherEntry','/out:'+output,'/win32icon:'+join(root,'apps/desktop/electron/icon.ico'),
    '/win32manifest:'+join(root,'installer/launcher.manifest'),'/reference:System.Windows.Forms.dll','/reference:System.Web.Extensions.dll',
    '/reference:System.IO.Compression.dll',...launcherFiles.slice(0,4).map(file=>join(root,file))],
    {cwd:owner,env:{SystemRoot:process.env.SystemRoot,TEMP:owner,TMP:owner},deadlineMs:120000});
  await writeFile(join(owner,'compile.log'),result.output,{flag:'wx'});
  if(result.code!==0)throw Error('Desktop launcher compilation failed: '+owner);
  await policy.directPath(output,'file');return output;
}
async function createShortcut(launcher){
  const executable=join(process.env.SystemRoot??'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
  const result=await runBoundedChild(executable,['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(shortcutProgram,'utf16le').toString('base64')],
    {cwd:dirname(launcher),env:{SystemRoot:process.env.SystemRoot,USERPROFILE:process.env.USERPROFILE,APPDATA:process.env.APPDATA,LOCALAPPDATA:process.env.LOCALAPPDATA,
      ARCANE_DESKTOP_LAUNCHER:launcher},deadlineMs:30000});
  if(result.code!==0)throw Error('The installed app is ready, but the desktop shortcut could not be created. '+result.output.slice(0,1000));
  return result.output.trim();
}

/** Local verified-build deployment. Reuses the installation engine's immutable releases and atomic active record.
 * Never starts the app or interrupts an already open window. Host seams are for owned fixture tests only. */
export function createDesktopInstaller({engine=createWindowsInstallation(),launcherBuilder=buildLauncher,shortcut=createShortcut,sourceRoot=repository}={}){
  return Object.freeze({async install({bundle,installRoot}){
    const root=policy.localPath(installRoot),launcher=join(root,'Arcane.exe'),receiptPath=join(root,'desktop-launcher.json');
    const sourceSha256=await sourceDigest(sourceRoot);
    let receipt=null;
    try{
      receipt=JSON.parse((await updates.checkedBytes(receiptPath,4096)).toString('utf8'));
      if(!receipt||typeof receipt!=='object'||Array.isArray(receipt))throw Error('Invalid desktop launcher record.');
    }catch(error){if(error.code!=='ENOENT')throw error;}
    if(receipt){
      if(Object.keys(receipt).sort().join(',')!=='sha256,sourceSha256,version'||receipt.version!==1||receipt.sourceSha256!==sourceSha256||!/^[a-f0-9]{64}$/.test(receipt.sha256))
        throw Error('The stable desktop launcher needs repair; installed releases were retained.');
      if(digest(await updates.checkedBytes(launcher,64*1024*1024))!==receipt.sha256)throw Error('The stable desktop launcher changed; installed releases were retained.');
    }else{
      try{await lstat(launcher);throw Error('An unowned desktop launcher already exists.');}catch(error){if(error.code!=='ENOENT')throw error;}
    }
    const result=await engine.install({bundle,installRoot});await policy.directPath(root);
    if(!receipt){
      const built=await launcherBuilder(sourceRoot);await policy.directPath(built,'file');
      const bytes=await updates.checkedBytes(built,64*1024*1024);if(bytes.length<64||bytes.toString('ascii',0,2)!=='MZ'||await sourceDigest(sourceRoot)!==sourceSha256)throw Error('Invalid desktop launcher.');
      await copyFile(built,launcher,constants.COPYFILE_EXCL);
      if(digest(await readFile(launcher))!==digest(bytes))throw Error('Desktop launcher copy changed.');
      await writeFile(receiptPath,JSON.stringify({version:1,sha256:digest(bytes),sourceSha256})+'\n',{flag:'wx',mode:0o600});
    }
    const desktopShortcut=await shortcut(launcher);
    if(typeof desktopShortcut!=='string'||!desktopShortcut)throw Error('Desktop shortcut was not confirmed.');
    return {...result,launcher,desktopShortcut,shortcuts:true,launched:false};
  }});
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2);
  if(args.length!==2||args[0]!=='--bundle'||!isAbsolute(args[1])||!process.env.LOCALAPPDATA)throw Error('Usage: node scripts/install-desktop.mjs --bundle ABSOLUTE_BUNDLE');
  const root=join(process.env.LOCALAPPDATA,'Arcane','Desktop');
  await mkdir(dirname(root),{recursive:true});await policy.directPath(dirname(root));
  console.log(JSON.stringify(await createDesktopInstaller().install({bundle:args[1],installRoot:root})));
}
