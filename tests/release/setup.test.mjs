// Offline source/fixture checks only. Never execute PowerShell, npm, providers or Studio.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { win32 } from 'node:path';

const setup = (await readFile(new URL('../../scripts/setup-arcane.ps1', import.meta.url), 'utf8')).replace(/\r\n?/g, '\n');
const launcher = (await readFile(new URL('../../scripts/launch-arcane.cmd', import.meta.url), 'utf8')).replace(/\r\n?/g, '\n');
const guide = await readFile(new URL('../../docs/build/FIRST_RUN.md', import.meta.url), 'utf8');
const pkg = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));

const forbidden = [
  /\b(?:Invoke-Expression|iex|Invoke-WebRequest|Invoke-RestMethod|Start-Process|Start-Job|Start-ThreadJob)\b/i,
  /\b(?:Remove-Item|Move-Item|Rename-Item|Set-ExecutionPolicy|Set-MpPreference|Add-MpPreference|New-Service|Set-Service|Stop-Service)\b/i,
  /\b(?:reg(?:\.exe)?|regedit|netsh|schtasks|bcdedit|msiexec|winget|choco|scoop|taskkill)\b/i,
  /\b(?:cmd(?:\.exe)?\s+\/c|powershell(?:\.exe)?\s+.*-(?:Command|EncodedCommand)|curl(?:\.exe)?\s|wget(?:\.exe)?\s)/i,
  /-(?:Verb\s+RunAs|WindowStyle\s+Hidden|ExecutionPolicy\s+(?:Bypass|Unrestricted)|EncodedCommand)\b/i,
  /\b(?:rmdir|rd|del|erase)\s+\/[sqf]\b/i,
  /\b(?:npm(?:\.cmd)?\s+(?:install|update|config|login)|npx(?:\.cmd)?|codex\s+(?:login|exec|app-server)|claude\s+(?:login|auth))\b/i,
  /\$env:[A-Za-z_][\w]*\s*=/i,
  /\[(?:System\.)?Environment\]::SetEnvironmentVariable\s*\(/i,
  /(?:auth\.json|credentials\.json|\.codex[\\/]|\.claude[\\/]|ARCANE_LOCAL_TOKEN|OPENAI_API_KEY|API_KEY\s*=)/i,
  /(?:%\*|\$args\b|ValueFromRemainingArguments|\.\s*Invoke\s*\(|ScriptBlock\]::Create)/i,
];
const violations = source => forbidden.filter(pattern => pattern.test(source));

// Extract only fixed single-quoted arrays; arbitrary interpolated argv fails the contract.
function npmActions(source) {
  const entries = [...source.matchAll(/'([A-Za-z]+)'\s*\{\s*\$npmArguments\s*=\s*@\(([^\r\n)]*)\)\s*\}/g)];
  return Object.fromEntries(entries.map(([, action, body]) => {
    assert.match(body, /^'[^']*'(?:\s*,\s*'[^']*')*$/);
    return [action, [...body.matchAll(/'([^']*)'/g)].map(match => match[1])];
  }));
}

test('bootstrap permits only three explicit opt-ins and anchors all repo paths to itself', () => {
  assert.match(setup, /^#requires -Version 5\.1/m);
  const parameters = setup.match(/\[CmdletBinding\(\)\]\s*param\(([\s\S]*?)\n\)/)?.[1];
  assert.ok(parameters);
  assert.deepEqual([...parameters.matchAll(/\[switch\]\$(\w+)/g)].map(match => match[1]), ['InstallDependencies', 'Prepare', 'Launch']);
  assert.doesNotMatch(parameters, /=|\[string\]|\$true/);
  assert.match(setup, /Resolve-Path -LiteralPath \(Join-Path -Path \$PSScriptRoot -ChildPath '\.\.'\)/);
  assert.match(setup, /Push-Location -LiteralPath \$repoRoot/);
  assert.match(setup, /\(Get-Location\)\.ProviderPath -cne \$repoRoot/);
  assert.match(setup, /finally\s*\{\s*if \(\$locationPushed\) \{ Pop-Location \}/);
  assert.match(setup, /StartsWith\(\$repoBoundary, \[StringComparison\]::OrdinalIgnoreCase\)/);
  for (const line of setup.split(/\r?\n/).filter(line => /(?:Test-Path|Resolve-Path|Get-Content|Push-Location)\s/.test(line))) {
    assert.match(line, /-LiteralPath\b/, line);
    assert.doesNotMatch(line, /(?:^|\s)-Path\s+\$(?:candidate|packagePath|repoRoot|nodeCommand|npmCommand|npmCliCandidate|compilerPath)/, line);
  }
  assert.doesNotMatch(setup + launcher, /\b[A-Za-z]:[\\/]|alexk|Hunted/i);
});

test('relocated checkout fixtures keep spaces, Unicode and metacharacters as path data', () => {
  const fixtures = [
    'C:\\Games\\Arcane',
    'D:\\Own Projects\\Arcane [copy]',
    'C:\\Users\\New User\\日本語 & Arcane',
    'D:\\Work\\Arcane & echo injected',
    'D:\\Work\\Arcane !special! %name%',
  ];
  for (const root of fixtures) {
    const scriptRoot = win32.join(root, 'scripts');
    assert.equal(win32.resolve(scriptRoot, '..'), root);
    assert.equal(win32.join(scriptRoot, 'setup-arcane.ps1'), root + '\\scripts\\setup-arcane.ps1');
  }
  const invocation = launcher.split(/\r?\n/).filter(line => /powershell\.exe"/i.test(line));
  assert.deepEqual(invocation, ['"%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoLogo -NoProfile -ExecutionPolicy RemoteSigned -File "%~dp0setup-arcane.ps1" -Launch']);
  assert.match(setup, /& \$nodeExecutable \$npmCli @npmArguments \| Out-Host/);
  assert.doesNotMatch(setup, /(?:-ArgumentList|cmd\.exe|&\s*\$npm(?:Shim|Command)|&\s*['"]npm)/i);
});

test('validation targets the real Arcane package, Node 24+ and installed application entries', () => {
  assert.match(setup, /\$package\.name -cne 'arcane'/);
  assert.match(setup, /\$package\.engines\.node -cne '>=24'/);
  assert.match(setup, /\[int\]\$Matches\[1\] -lt 24/);
  assert.match(setup, /Get-Command -Name 'node\.exe' -CommandType Application/);
  assert.match(setup, /Get-Command -Name 'npm\.cmd' -CommandType Application/);
  assert.match(setup, /-ChildPath 'node_modules\/npm\/bin\/npm-cli\.js'/);
  assert.match(setup, /\$property\.Value -cne \$entry\.Value/);
  for (const name of ['build', 'build:plugin', 'start:arcane']) assert.ok(setup.includes(`'${name}' = '${pkg.scripts[name]}'`));
  assert.match(setup, /Get-ArcaneRepoFile 'scripts\/product-doctor\.mjs'/);
  assert.match(setup, /& \$nodeExecutable \$doctorScript/);
  assert.match(setup, /\$report\.scope -cne 'local-runtime-files-and-dependencies'/);
  assert.match(setup, /\$report\.credentialsRead -ne \$false/);
  assert.match(setup, /\$report\.networkUsed -ne \$false/);
  assert.match(setup, /\$report\.installsPerformed -ne \$false/);
  assert.ok(setup.includes('https://nodejs.org/en/download'));
  assert.ok(setup.includes('https://docs.npmjs.com/downloading-and-installing-node-js-and-npm'));
});

test('fixed npm argv blocks implicit installs, lifecycle hooks, global flags and injected text', () => {
  const actions = npmActions(setup);
  assert.deepEqual(actions, {
    Version: ['--version'],
    Install: ['ci', '--ignore-scripts', '--no-audit', '--no-fund', '--include=dev'],
    Build: ['run', 'build', '--ignore-scripts'],
    Plugin: ['run', 'build:plugin', '--ignore-scripts'],
    Launch: ['run', 'start:arcane', '--ignore-scripts'],
  });
  assert.match(setup, /ValidateSet\('Version', 'Install', 'Build', 'Plugin', 'Launch'\)/);
  const calls = [...setup.matchAll(/Invoke-ArcaneNpm\s+'(\w+)'/g)].map(match => match[1]);
  assert.deepEqual(calls, ['Version', 'Install', 'Build', 'Plugin', 'Launch']);
  const installStart = setup.indexOf('if ($InstallDependencies)');
  const prepareStart = setup.indexOf('if ($Prepare)');
  const launchStart = setup.indexOf('if ($Launch)');
  const install = setup.slice(installStart, prepareStart);
  const prepare = setup.slice(prepareStart, setup.indexOf("Write-Host 'Checking compiled output"));
  const launch = setup.slice(launchStart, setup.indexOf('} catch {', launchStart));
  assert.match(install, /Get-ArcaneRepoFile 'package-lock\.json'/);
  assert.match(install, /\$lock\.name -cne 'arcane'.*\$lock\.lockfileVersion -ne 3/);
  assert.match(install, /Invoke-ArcaneNpm 'Install'/);
  assert.match(prepare, /Invoke-ArcaneNpm 'Build'[\s\S]*exit \$arcaneExitCode[\s\S]*Invoke-ArcaneNpm 'Plugin'/);
  assert.match(launch, /Invoke-ArcaneNpm 'Launch'[\s\S]*exit \$arcaneExitCode/);
  assert.ok(installStart >= 0 && prepareStart > installStart && launchStart > prepareStart);
  assert.throws(() => npmActions(setup.replace("@('ci', '--ignore-scripts'", "@($userText, '--ignore-scripts'")), assert.AssertionError);
});

test('local preflight gates foreground launch and native failures preserve their codes', () => {
  assert.match(setup, /\$commandExitCode = \$LASTEXITCODE/);
  assert.match(setup, /return \[int\]\$commandExitCode/);
  assert.match(setup, /\$nodeVersionExitCode = \$LASTEXITCODE/);
  assert.match(setup, /\$arcaneExitCode = \$nodeVersionExitCode/);
  assert.match(setup, /\$doctorExitCode = \$LASTEXITCODE/);
  assert.match(setup, /if \(\$doctorExitCode -ne 0\) \{ exit \$doctorExitCode \}/);
  const failure = setup.indexOf('if ($doctorExitCode -ne 0 -or -not $report.readyToLaunch)');
  assert.ok(failure >= 0 && failure < setup.indexOf('if ($Launch)'));
  assert.match(setup.slice(failure, setup.indexOf('if ($Launch)')), /exit 1/);
  assert.match(setup, /\} catch \{\s*if \(\$arcaneExitCode -eq 0\) \{ \$arcaneExitCode = 2 \}/);
  assert.match(setup, /exit \$arcaneExitCode\s*$/);
  assert.match(launcher, /set "ARCANE_LAUNCH_EXIT=%ERRORLEVEL%"/);
  assert.match(launcher, /^setlocal DisableDelayedExpansion$/m);
  assert.match(launcher, /exit \/b %ARCANE_LAUNCH_EXIT%\s*$/);
  assert.doesNotMatch(launcher, /(?:\bstart\s|InstallDependencies\s+-Prepare|%[1-9])/i);
  assert.equal(pkg.scripts['setup:arcane'], 'powershell.exe -NoLogo -NoProfile -ExecutionPolicy RemoteSigned -File scripts/setup-arcane.ps1');
});

test('safety scanner rejects dangerous data-only mutations of the bootstrap', () => {
  assert.deepEqual(violations(setup), []);
  assert.deepEqual(violations(launcher), []);
  const maliciousFixtures = [
    'Invoke-Expression $userCommand',
    'Remove-Item -LiteralPath $repoRoot -Recurse',
    'Move-Item -LiteralPath $repoRoot -Destination C:\\Other',
    'Start-Process powershell.exe -WindowStyle Hidden',
    'Set-MpPreference -DisableRealtimeMonitoring $true',
    'Set-ExecutionPolicy Unrestricted -Scope LocalMachine',
    'npm install -g typescript',
    'npm config set prefix other',
    'cmd.exe /c $userText',
    'powershell.exe -EncodedCommand payload',
    'codex login',
    'codex exec prompt',
    '$env:PATH = $newPath',
    'Get-Content -LiteralPath "$HOME/.codex/auth.json"',
    '%*',
    '$args',
  ];
  for (const fixture of maliciousFixtures) assert.ok(violations(setup + '\n' + fixture).length > 0, fixture);
});

test('first-run guide keeps provider login human-owned and Studio acceptance deferred', () => {
  for (const phrase of ['Node 24+', 'Windows PowerShell 5.1', '-InstallDependencies', '-Prepare', '-Launch', 'npm ci --ignore-scripts', 'Ctrl+C', 'codex login', '**Connect**', 'metadata', 'explicitly deferred', 'shared SaaS subscription']) assert.ok(guide.includes(phrase), phrase);
  assert.ok(guide.includes('https://learn.chatgpt.com/docs/codex/cli'));
  assert.ok(guide.includes('https://learn.chatgpt.com/docs/auth'));
  assert.doesNotMatch(guide, /alexk|C:\\Users\\|Hunted|npm install -g|ExecutionPolicy Bypass/i);
});
