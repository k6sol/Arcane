#requires -Version 5.1
<#
.SYNOPSIS
Checks this Arcane checkout; changes require an explicit switch.
.EXAMPLE
powershell.exe -NoProfile -File .\scripts\setup-arcane.ps1
.EXAMPLE
powershell.exe -NoProfile -File .\scripts\setup-arcane.ps1 -InstallDependencies -Prepare -Launch
#>
[CmdletBinding()]
param(
    [switch]$InstallDependencies,
    [switch]$Prepare,
    [switch]$Launch
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$arcaneExitCode = 2
$locationPushed = $false

function Show-ArcaneNextSteps {
    Write-Host ''
    Write-Host 'From your Arcane folder, choose the steps you want:'
    Write-Host '  powershell.exe -NoProfile -ExecutionPolicy RemoteSigned -File .\scripts\setup-arcane.ps1 -InstallDependencies'
    Write-Host '  powershell.exe -NoProfile -ExecutionPolicy RemoteSigned -File .\scripts\setup-arcane.ps1 -Prepare'
    Write-Host '  powershell.exe -NoProfile -ExecutionPolicy RemoteSigned -File .\scripts\setup-arcane.ps1 -Launch'
    Write-Host 'You can combine those switches. Read docs\build\FIRST_RUN.md for the first-run walkthrough.'
}

function Get-ArcaneRepoFile {
    param([string]$RelativePath)
    $candidate = Join-Path -Path $repoRoot -ChildPath $RelativePath
    if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
        throw "Missing $RelativePath in this Arcane folder. Use a complete clone or source release."
    }
    $resolved = (Resolve-Path -LiteralPath $candidate).ProviderPath
    if (-not $resolved.StartsWith($repoBoundary, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'A required file is outside this Arcane folder.'
    }
    return $resolved
}

function Invoke-ArcaneNpm {
    param([ValidateSet('Version', 'Install', 'Build', 'Plugin', 'Launch')][string]$Action)
    # Execute the installed npm JS entry with node.exe, avoiding cmd/PowerShell shims.
    # Every argument is fixed here; no user command text or arbitrary flags are accepted.
    switch ($Action) {
        'Version' { $npmArguments = @('--version') }
        'Install' { $npmArguments = @('ci', '--ignore-scripts', '--no-audit', '--no-fund', '--include=dev') }
        'Build' { $npmArguments = @('run', 'build', '--ignore-scripts') }
        'Plugin' { $npmArguments = @('run', 'build:plugin', '--ignore-scripts') }
        'Launch' { $npmArguments = @('run', 'start:arcane', '--ignore-scripts') }
    }
    & $nodeExecutable $npmCli @npmArguments | Out-Host
    $commandExitCode = $LASTEXITCODE
    if ($commandExitCode -ne 0) {
        Write-Host "Arcane $Action failed (exit code $commandExitCode). See the output above."
        Write-Host 'Setup stopped here. Resolve that failure before trying the next step.'
    }
    return [int]$commandExitCode
}

try {
    $repoRoot = (Resolve-Path -LiteralPath (Join-Path -Path $PSScriptRoot -ChildPath '..')).ProviderPath
    $repoBoundary = $repoRoot.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    $packagePath = Get-ArcaneRepoFile 'package.json'
    $package = Get-Content -LiteralPath $packagePath -Raw | ConvertFrom-Json
    if ($package.name -cne 'arcane' -or $package.engines.node -cne '>=24') {
        throw 'This script belongs in the Arcane repository (package name arcane, Node requirement >=24).'
    }
    # Check the actual entry points before allowing npm to run a repository script.
    $expectedScripts = @{
        'build' = 'node scripts/compile-product.mjs'
        'build:plugin' = 'node scripts/build-plugin.mjs'
        'start:arcane' = 'node scripts/start-product.mjs'
    }
    foreach ($entry in $expectedScripts.GetEnumerator()) {
        $property = $package.scripts.PSObject.Properties[$entry.Key]
        if ($null -eq $property -or $property.Value -cne $entry.Value) {
            throw "Arcane script $($entry.Key) is missing or changed. Review package.json before setup."
        }
    }
    $doctorScript = Get-ArcaneRepoFile 'scripts/product-doctor.mjs'
    $null = Get-ArcaneRepoFile 'scripts/compile-product.mjs'
    $null = Get-ArcaneRepoFile 'scripts/build-plugin.mjs'
    $null = Get-ArcaneRepoFile 'scripts/start-product.mjs'

    Push-Location -LiteralPath $repoRoot
    $locationPushed = $true
    if ((Get-Location).ProviderPath -cne $repoRoot) {
        throw 'Could not enter the Arcane folder. Setup has stopped.'
    }
    Write-Host 'Arcane first-run setup'
    Write-Host "Your checkout: $repoRoot"
    Write-Host 'Checking local prerequisites. Native clients are connected later by you.'

    $nodeCommand = Get-Command -Name 'node.exe' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -eq $nodeCommand) {
        Write-Host 'Node.js was not found. Get Node 24 or newer with npm, then reopen your terminal.'
        Write-Host 'Official Windows downloads (a ZIP is available for a user-owned folder): https://nodejs.org/en/download'
        Write-Host 'Node/npm setup: https://docs.npmjs.com/downloading-and-installing-node-js-and-npm'
        throw 'Node 24+ is required before Arcane can be checked or prepared.'
    }
    $nodeExecutable = (Resolve-Path -LiteralPath $nodeCommand.Source).ProviderPath
    $nodeVersionLines = @(& $nodeExecutable '--version')
    $nodeVersionExitCode = $LASTEXITCODE
    if ($nodeVersionExitCode -ne 0) {
        $arcaneExitCode = $nodeVersionExitCode
        throw "Node could not report its version (exit code $nodeVersionExitCode)."
    }
    $nodeVersion = ($nodeVersionLines -join '').Trim()
    if ($nodeVersion -notmatch '^v(\d+)\.\d+\.\d+$' -or [int]$Matches[1] -lt 24) {
        Write-Host 'Arcane requires a stable Node 24+ release: https://nodejs.org/en/download'
        throw "Your Node version ($nodeVersion) does not meet that requirement."
    }
    Write-Host "Found Node $nodeVersion."

    # Standard Windows npm layouts put npm-cli.js beside npm.cmd in node_modules/npm/bin.
    # Locate the application only; do not run npm.cmd or npm.ps1 from PATH.
    $npmCommand = Get-Command -Name 'npm.cmd' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -eq $npmCommand) {
        Write-Host 'npm was not found. Use the official Node distribution with npm, then reopen your terminal.'
        Write-Host 'Setup help: https://docs.npmjs.com/downloading-and-installing-node-js-and-npm'
        throw 'npm is required. Setup does not install global tools.'
    }
    $npmShim = (Resolve-Path -LiteralPath $npmCommand.Source).ProviderPath
    $npmCliCandidate = Join-Path -Path (Split-Path -Path $npmShim -Parent) -ChildPath 'node_modules/npm/bin/npm-cli.js'
    if (-not (Test-Path -LiteralPath $npmCliCandidate -PathType Leaf)) {
        Write-Host 'This npm shim layout is unsupported. Use the official Node Windows distribution containing npm.'
        Write-Host 'Download: https://nodejs.org/en/download'
        throw 'Could not locate the installed npm-cli.js safely.'
    }
    $npmCli = (Resolve-Path -LiteralPath $npmCliCandidate).ProviderPath
    Write-Host 'Checking npm version:'
    $arcaneExitCode = Invoke-ArcaneNpm 'Version'
    if ($arcaneExitCode -ne 0) { exit $arcaneExitCode }
    $arcaneExitCode = 2

    if ($InstallDependencies) {
        $lockPath = Get-ArcaneRepoFile 'package-lock.json'
        $lock = Get-Content -LiteralPath $lockPath -Raw | ConvertFrom-Json
        if ($lock.name -cne 'arcane' -or $lock.lockfileVersion -ne 3) {
            throw 'Expected the Arcane npm v3 package-lock.json. Restore it from your clone before installing.'
        }
        Write-Host 'Installing lockfile dependencies locally with npm ci --ignore-scripts.'
        Write-Host 'npm ci replaces this checkout''s node_modules and may download packages/use the npm cache.'
        $arcaneExitCode = Invoke-ArcaneNpm 'Install'
        if ($arcaneExitCode -ne 0) {
            Write-Host 'Check network access, folder permissions and lockfile consistency. No build or launch was attempted.'
            Write-Host 'Official npm ci help: https://docs.npmjs.com/cli/v11/commands/npm-ci'
            exit $arcaneExitCode
        }
        $arcaneExitCode = 2
    }

    if ($Prepare) {
        $compilerPath = Join-Path -Path $repoRoot -ChildPath 'node_modules/typescript/bin/tsc'
        if (-not (Test-Path -LiteralPath $compilerPath -PathType Leaf)) {
            throw 'Local compiler missing. Run setup with -InstallDependencies, then retry -Prepare.'
        }
        Write-Host 'Building Arcane with npm run build (one build at a time).'
        $arcaneExitCode = Invoke-ArcaneNpm 'Build'
        if ($arcaneExitCode -ne 0) {
            Write-Host 'The product build failed. The plugin build and launch were not attempted.'
            exit $arcaneExitCode
        }
        Write-Host 'Building the plugin artifact with npm run build:plugin.'
        $arcaneExitCode = Invoke-ArcaneNpm 'Plugin'
        if ($arcaneExitCode -ne 0) {
            Write-Host 'The plugin build failed. Launch was not attempted.'
            exit $arcaneExitCode
        }
        $arcaneExitCode = 2
    }

    Write-Host 'Checking compiled output, package-local dependencies and the plugin artifact:'
    $doctorLines = @(& $nodeExecutable $doctorScript)
    $doctorExitCode = $LASTEXITCODE
    if ($doctorExitCode -ne 0) { $arcaneExitCode = $doctorExitCode }
    $report = ($doctorLines -join [Environment]::NewLine) | ConvertFrom-Json
    if ($report.schemaVersion -ne 1 -or $report.scope -cne 'local-runtime-files-and-dependencies' -or
        $report.readyToLaunch -isnot [bool] -or $report.credentialsRead -ne $false -or
        $report.networkUsed -ne $false -or $report.installsPerformed -ne $false) {
        throw 'Unexpected local preflight report. Review scripts/product-doctor.mjs before continuing.'
    }
    foreach ($check in $report.checks) {
        if ($check.status -eq 'fail') { Write-Host ("  Needs attention: {0}: {1}" -f $check.id, $check.detail) }
    }
    if ($doctorExitCode -ne 0 -or -not $report.readyToLaunch) {
        Write-Host 'Arcane is not ready to launch. Missing dependencies need -InstallDependencies; missing or stale builds need -Prepare.'
        Show-ArcaneNextSteps
        if ($doctorExitCode -ne 0) { exit $doctorExitCode }
        exit 1
    }

    Write-Host 'Arcane local files are ready. Plugin installation, provider access and Studio testing are separate.'
    Write-Host 'For Codex, install the native CLI and sign in yourself before clicking Connect in Arcane.'
    Write-Host 'Official CLI setup: https://learn.chatgpt.com/docs/codex/cli'
    if ($Launch) {
        Write-Host 'Starting npm run start:arcane in this window. Open its private workbench link; stop with Ctrl+C.'
        $arcaneExitCode = Invoke-ArcaneNpm 'Launch'
        exit $arcaneExitCode
    }
    Show-ArcaneNextSteps
    $arcaneExitCode = 0
} catch {
    if ($arcaneExitCode -eq 0) { $arcaneExitCode = 2 }
    Write-Host ("Arcane setup: {0}" -f $_.Exception.Message)
    Write-Host 'See docs\build\FIRST_RUN.md for setup and troubleshooting.'
} finally {
    if ($locationPushed) { Pop-Location }
}
exit $arcaneExitCode
