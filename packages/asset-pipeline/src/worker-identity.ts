import { execFile as nodeExecFile } from 'node:child_process';
import { win32 } from 'node:path';

/** Exact identity of one host-owned asset worker process.
 * Recorded only by the supervisor that spawned it; never accepted from HTTP, MCP or a model.
 * Windows identifies a live process by its PID, but PIDs are reused after exit, so the
 * OS creation time recorded at spawn is part of the identity. */
export const WORKER_ROLES = Object.freeze(['probe', 'python-probe', 'generate'] as const);
export type WorkerRole = typeof WORKER_ROLES[number];
export interface WorkerIdentity {
  /** 1: legacy CIM timestamp; 2: exact native FILETIME timestamp. */
  readonly schemaVersion: 1 | 2;
  readonly role: WorkerRole;
  readonly pid: number;
  readonly processCreatedAt: string;
  readonly executable: string;
}
export type CaptureResult =
  | { status: 'captured'; identity: WorkerIdentity }
  | { status: 'uncertain'; reason: AttestationReason };
export type WorkerVerdict = 'same-worker-running' | 'recorded-worker-gone' | 'unknown';
export type AttestationReason =
  | 'identity-matched' | 'pid-absent' | 'pid-reused'
  | 'identity-missing' | 'identity-invalid' | 'platform-unsupported' | 'host-unavailable'
  | 'query-failed' | 'query-timeout' | 'query-unsettled' | 'output-oversized' | 'output-malformed'
  | 'metadata-inaccessible' | 'identity-conflict' | 'executable-mismatch';
/** Diagnostics are fixed codes only: no raw process paths, command lines or query output. */
export interface Attestation { readonly verdict: WorkerVerdict; readonly reason: AttestationReason }

type ExecError = (Error & { code?: unknown; killed?: boolean; signal?: unknown }) | null;
type ExecCallback = (error: ExecError, stdout: string, stderr: string) => void;
/** The owned helper process handle, when the host exposes one (Node's ChildProcess does). */
export interface OwnedQuery { kill?(): boolean }
export interface ProcessQueryHost {
  platform: string;
  systemRoot: string | undefined;
  execFile(file: string, args: readonly string[], options: {
    cwd: string; env: Record<string, string>; shell: false; windowsHide: true; timeout: number; maxBuffer: number; encoding: 'utf8';
  }, callback: ExecCallback): OwnedQuery | undefined | void;
}
export const defaultProcessQueryHost: ProcessQueryHost = {
  platform: process.platform,
  systemRoot: process.env.SystemRoot,
  execFile: (file, args, options, callback) => nodeExecFile(file, [...args], options, (error, stdout, stderr) =>
    callback(error as ExecError, String(stdout), String(stderr))),
};

export const QUERY_TIMEOUT_MS = 5000;
/** Adapter-owned bound in case the host never reports completion (lost callback, stuck helper). */
export const QUERY_WATCHDOG_MS = QUERY_TIMEOUT_MS + 2000;
export const QUERY_MAX_OUTPUT_BYTES = 4096;
const MAX_PID = 0xffffffff;
const TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{7})Z$/;
// Constant script. Only a validated decimal PID comes from the environment.
// One same-handle native identity query; no enumeration, privilege changes or compiler.
export const WORKER_QUERY_SCRIPT = [
  "# Fixed exact-PID query. No caller-provided code or method names.",
  "$ErrorActionPreference = 'Stop'",
  "$queryStage = 0; $queryFailureStage = -1",
  "try {",
  "  [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)",
  "  $raw = [Environment]::GetEnvironmentVariable('ARCANE_WORKER_PID')",
  "  [uint32]$workerPid = 0",
  "  if ($raw -notmatch '^[1-9][0-9]{0,9}$' -or -not [uint32]::TryParse($raw, [Globalization.NumberStyles]::None, [Globalization.CultureInfo]::InvariantCulture, [ref]$workerPid) -or $workerPid -eq 0) { exit 3 }",
  "  $queryStage = 1",
  "  $assembly = [AppDomain]::CurrentDomain.DefineDynamicAssembly([Reflection.AssemblyName]::new('ArcaneWorkerIdentity'), [Reflection.Emit.AssemblyBuilderAccess]::Run)",
  "  $module = $assembly.DefineDynamicModule('Native')",
  "  $typeBuilder = $module.DefineType('ArcaneWorkerIdentity.Native', [Reflection.TypeAttributes]'Public,Abstract,Sealed')",
  "  $attributeType = [Runtime.InteropServices.DllImportAttribute]",
  "  $constructor = $attributeType.GetConstructor([type[]]@([string]))",
  "  [Reflection.FieldInfo[]]$fields = @('EntryPoint','SetLastError','ExactSpelling','CharSet','CallingConvention') | ForEach-Object { $attributeType.GetField($_) }",
  "  $imports = @{}",
  "  function Bind([string]$name, [type]$returnType, [type[]]$parameters) {",
  "    $method = $typeBuilder.DefinePInvokeMethod($name, 'kernel32.dll', $name, [Reflection.MethodAttributes]'Public,Static,PinvokeImpl', [Reflection.CallingConventions]::Standard, $returnType, $parameters, [Runtime.InteropServices.CallingConvention]::Winapi, [Runtime.InteropServices.CharSet]::Unicode)",
  "    [object[]]$values = @($name, $true, $true, [Runtime.InteropServices.CharSet]::Unicode, [Runtime.InteropServices.CallingConvention]::Winapi)",
  "    $method.SetCustomAttribute([Reflection.Emit.CustomAttributeBuilder]::new($constructor, [object[]]@('kernel32.dll'), $fields, $values))",
  "    $method.SetImplementationFlags($method.GetMethodImplementationFlags() -bor [Reflection.MethodImplAttributes]::PreserveSig)",
  "    $imports[$name] = $method",
  "  }",
  "  Bind 'OpenProcess' ([IntPtr]) ([type[]]@([uint32],[int32],[uint32]))",
  "  Bind 'GetProcessTimes' ([int32]) ([type[]]@([IntPtr],[long].MakeByRefType(),[long].MakeByRefType(),[long].MakeByRefType(),[long].MakeByRefType()))",
  "  Bind 'QueryFullProcessImageNameW' ([int32]) ([type[]]@([IntPtr],[uint32],[Text.StringBuilder],[uint32].MakeByRefType()))",
  "  Bind 'WaitForSingleObject' ([uint32]) ([type[]]@([IntPtr],[uint32]))",
  "  Bind 'CloseHandle' ([int32]) ([type[]]@([IntPtr]))",
  "  # Cache last error inside managed IL, before Reflection.Invoke/PowerShell resumes.",
  "  $queryStage = 2",
  "  $openWrapper = $typeBuilder.DefineMethod('OpenProcessWithError', [Reflection.MethodAttributes]'Public,Static', [IntPtr], [type[]]@([uint32],[int32],[uint32],[int32].MakeByRefType()))",
  "  $il = $openWrapper.GetILGenerator()",
  "  $handleLocal = $il.DeclareLocal([IntPtr])",
  "  $il.Emit([Reflection.Emit.OpCodes]::Ldarg_0)",
  "  $il.Emit([Reflection.Emit.OpCodes]::Ldarg_1)",
  "  $il.Emit([Reflection.Emit.OpCodes]::Ldarg_2)",
  "  $il.Emit([Reflection.Emit.OpCodes]::Call, $imports['OpenProcess'])",
  "  $il.Emit([Reflection.Emit.OpCodes]::Stloc, $handleLocal)",
  "  $il.Emit([Reflection.Emit.OpCodes]::Ldarg_3)",
  "  $il.Emit([Reflection.Emit.OpCodes]::Call, [Runtime.InteropServices.Marshal].GetMethod('GetLastWin32Error', [Type]::EmptyTypes))",
  "  $il.Emit([Reflection.Emit.OpCodes]::Stind_I4)",
  "  $il.Emit([Reflection.Emit.OpCodes]::Ldloc, $handleLocal)",
  "  $il.Emit([Reflection.Emit.OpCodes]::Ret)",
  "  $queryStage = 3",
  "  $nativeType = $typeBuilder.CreateType()",
  "  foreach ($name in @('OpenProcess','GetProcessTimes','QueryFullProcessImageNameW','WaitForSingleObject','CloseHandle')) {",
  "    $method = $nativeType.GetMethod($name)",
  "    $attributes = @($method.GetCustomAttributes($attributeType, $false))",
  "    if ($attributes.Count -ne 1 -or $attributes[0].Value -ne 'kernel32.dll' -or $attributes[0].EntryPoint -ne $name -or -not $attributes[0].SetLastError -or -not $attributes[0].ExactSpelling -or $attributes[0].CharSet -ne [Runtime.InteropServices.CharSet]::Unicode -or $attributes[0].CallingConvention -ne [Runtime.InteropServices.CallingConvention]::Winapi -or -not ($method.GetMethodImplementationFlags() -band [Reflection.MethodImplAttributes]::PreserveSig)) { [Console]::Error.Write('ARCANE_WORKER_QUERY_STAGE:3'); exit 4 }",
  "  }",
  "  [IntPtr]$workerHandle = [IntPtr]::Zero",
  "  $observation = $null; $failed = $false",
  "  try {",
  "    $queryStage = 4",
  "    [object[]]$openArguments = @([uint32]0x101000,[int32]0,$workerPid,[int32]0)",
  "    $workerHandle = $nativeType.GetMethod('OpenProcessWithError').Invoke($null, $openArguments)",
  "    $queryLastError = $openArguments[3]",
  "    if ($workerHandle -eq [IntPtr]::Zero) {",
  "      if ($queryLastError -eq 87) { $observation = [ordered]@{v=2;found=$false} } else { $failed = $true; $queryFailureStage = 4 }",
  "    } else {",
  "      $queryStage = 5",
  "      $before = $nativeType.GetMethod('WaitForSingleObject').Invoke($null, [object[]]@($workerHandle,[uint32]0))",
  "      if ($before -eq 0) { $observation = [ordered]@{v=2;found=$false} }",
  "      elseif ($before -eq 258) {",
  "        $created = $null; $executable = $null",
  "        $queryStage = 6",
  "        [object[]]$timeArguments = @($workerHandle,[long]0,[long]0,[long]0,[long]0)",
  "        if ($nativeType.GetMethod('GetProcessTimes').Invoke($null, $timeArguments) -ne 0) {",
  "          try { $created = [DateTime]::FromFileTimeUtc([long]$timeArguments[1]).ToString('o', [Globalization.CultureInfo]::InvariantCulture) } catch { $created = $null }",
  "        }",
  "        $queryStage = 7",
  "        $pathBuffer = [Text.StringBuilder]::new(4096)",
  "        [object[]]$pathArguments = @($workerHandle,[uint32]0,$pathBuffer,[uint32]4096)",
  "        if ($nativeType.GetMethod('QueryFullProcessImageNameW').Invoke($null, $pathArguments) -ne 0 -and $pathArguments[3] -gt 0 -and $pathArguments[3] -lt 4096) { $executable = $pathBuffer.ToString(0, [int]$pathArguments[3]) }",
  "        $queryStage = 8",
  "        $after = $nativeType.GetMethod('WaitForSingleObject').Invoke($null, [object[]]@($workerHandle,[uint32]0))",
  "        if ($after -eq 0) { $observation = [ordered]@{v=2;found=$false} }",
  "        elseif ($after -eq 258) { $observation = [ordered]@{v=2;found=$true;pid=$workerPid;created=$created;executable=$executable} }",
  "        else { $failed = $true; $queryFailureStage = 8 }",
  "      } else { $failed = $true; $queryFailureStage = 5 }",
  "    }",
  "  } catch {",
  "    if ($queryFailureStage -eq -1) { $queryFailureStage = $queryStage }",
  "    throw",
  "  } finally {",
  "    $queryStage = 9",
  "    if ($workerHandle -ne [IntPtr]::Zero -and $nativeType.GetMethod('CloseHandle').Invoke($null, [object[]]@($workerHandle)) -eq 0) { $failed = $true; if ($queryFailureStage -eq -1) { $queryFailureStage = 9 } }",
  "  }",
  "  if ($failed -or $null -eq $observation) { if ($queryFailureStage -eq -1) { $queryFailureStage = $queryStage }; try { [Console]::Error.Write('ARCANE_WORKER_QUERY_STAGE:' + $queryFailureStage) } catch {}; exit 4 }",
  "  $queryStage = 10",
  "  [Console]::Out.Write(($observation | ConvertTo-Json -Compress))",
  "  exit 0",
  "} catch {",
  "  if ($queryFailureStage -eq -1) { $queryFailureStage = $queryStage }",
  "  try { [Console]::Error.Write('ARCANE_WORKER_QUERY_STAGE:' + $queryFailureStage) } catch {}",
  "  exit 4",
  "}",
].join('\n');
const ENCODED_SCRIPT = Buffer.from(WORKER_QUERY_SCRIPT, 'utf16le').toString('base64');

const validPid = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= MAX_PID;
const localAbsolute = (value: unknown): value is string => typeof value === 'string' && value.length <= 4096 &&
  /^[A-Za-z]:\\/.test(value) && !/[\x00-\x1f\x7f]/.test(value) && win32.normalize(value) === value;
const sameExecutable = (a: string, b: string) => win32.normalize(a).toLowerCase() === win32.normalize(b).toLowerCase();
const validRole = (value: unknown): value is WorkerRole => (WORKER_ROLES as readonly unknown[]).includes(value);

/** Canonical UTC with seven fractional digits AND a real calendar instant (no Feb 30, hour 24, leap
 * second, or year before the Windows FILETIME epoch). Anything else cannot prove PID reuse. */
export function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = TIMESTAMP.exec(value);
  if (!match) return false;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number) as [number, number, number, number, number, number];
  if (year < 1601 || month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) return false;
  const instant = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  return instant.getUTCFullYear() === year && instant.getUTCMonth() === month - 1 && instant.getUTCDate() === day;
}

/** Fixed argv/env for the query. Exported for verification only; callers cannot alter it. */
export function workerQueryInvocation(host: ProcessQueryHost, pid: number) {
  if (!validPid(pid)) throw new Error('Invalid worker PID.');
  const systemRoot = host.systemRoot;
  if (!localAbsolute(systemRoot)) throw new Error('Trusted system root unavailable.');
  const system32 = win32.join(systemRoot, 'System32');
  return Object.freeze({
    file: win32.join(system32, 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    args: Object.freeze(['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', ENCODED_SCRIPT]),
    options: Object.freeze({ cwd: system32, env: Object.freeze({ SystemRoot: systemRoot, ARCANE_WORKER_PID: String(pid) }),
      shell: false as const, windowsHide: true as const, timeout: QUERY_TIMEOUT_MS, maxBuffer: QUERY_MAX_OUTPUT_BYTES, encoding: 'utf8' as const }),
  });
}

type Observation =
  | { kind: 'absent' }
  | { kind: 'present'; created: string | null; executable: string | null }
  | { kind: 'failed'; reason: AttestationReason };

function parseObservation(pid: number, stdout: string): Observation {
  if (Buffer.byteLength(stdout) > QUERY_MAX_OUTPUT_BYTES) return { kind: 'failed', reason: 'output-oversized' };
  let value: unknown;
  try { value = JSON.parse(stdout.replace(/^﻿/, '').trim()); } catch { return { kind: 'failed', reason: 'output-malformed' }; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { kind: 'failed', reason: 'output-malformed' };
  const record = value as Record<string, unknown>, keys = Object.keys(record).sort().join(',');
  if (record.v !== 2) return { kind: 'failed', reason: 'output-malformed' };
  if (keys === 'found,v' && record.found === false) return { kind: 'absent' };
  if (keys !== 'created,executable,found,pid,v' || record.found !== true || record.pid !== pid) return { kind: 'failed', reason: 'output-malformed' };
  if (record.created !== null && !canonicalTimestamp(record.created)) return { kind: 'failed', reason: 'output-malformed' };
  if (record.executable !== null && !localAbsolute(record.executable)) return { kind: 'failed', reason: 'output-malformed' };
  return { kind: 'present', created: record.created as string | null, executable: record.executable as string | null };
}

/** One bounded query. The adapter's own watchdog settles even if the host never calls back; it then
 * asks the owned helper to stop but cannot confirm its closure, so the outcome is `query-unsettled`. */
function observe(host: ProcessQueryHost, pid: number): Promise<Observation> {
  if (host.platform !== 'win32') return Promise.resolve({ kind: 'failed', reason: 'platform-unsupported' });
  let invocation: ReturnType<typeof workerQueryInvocation>;
  try { invocation = workerQueryInvocation(host, pid); } catch { return Promise.resolve({ kind: 'failed', reason: 'host-unavailable' }); }
  return new Promise(resolve => {
    let settled = false, owned: OwnedQuery | undefined | void;
    const done = (value: Observation) => { if (settled) return; settled = true; clearTimeout(watchdog); resolve(value); };
    const watchdog = setTimeout(() => {
      // Settle as unknown BEFORE cleanup: a kill that synchronously reports completion cannot win.
      done({ kind: 'failed', reason: 'query-unsettled' });
      try { if (owned && typeof owned.kill === 'function') owned.kill(); } catch { /* Closure stays unconfirmed either way. */ }
    }, QUERY_WATCHDOG_MS);
    try {
      owned = host.execFile(invocation.file, invocation.args, { ...invocation.options, env: { ...invocation.options.env } }, (error, stdout) => {
        if (error) {
          if (error.killed === true || error.signal === 'SIGTERM') return done({ kind: 'failed', reason: 'query-timeout' });
          if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return done({ kind: 'failed', reason: 'output-oversized' });
          return done({ kind: 'failed', reason: 'query-failed' });
        }
        done(parseObservation(pid, typeof stdout === 'string' ? stdout : ''));
      });
    } catch { done({ kind: 'failed', reason: 'query-failed' }); }
  });
}

/** Strict, data-property-only read into a frozen copy. Accessors, extra keys and invalid values are refused,
 * so later mutation of the caller's object (or a getter) cannot change what is attested. */
export function parseWorkerIdentity(value: unknown): WorkerIdentity | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  let descriptors: Record<string, PropertyDescriptor>;
  try { descriptors = Object.getOwnPropertyDescriptors(value); } catch { return null; }
  const keys = Object.keys(descriptors).sort().join(',');
  if (keys !== 'executable,pid,processCreatedAt,role,schemaVersion' || Object.values(descriptors).some(d => !('value' in d))) return null;
  const schemaVersion = descriptors.schemaVersion!.value, role = descriptors.role!.value, pid = descriptors.pid!.value;
  const processCreatedAt = descriptors.processCreatedAt!.value, executable = descriptors.executable!.value;
  if ((schemaVersion !== 1 && schemaVersion !== 2) || !validRole(role) || !validPid(pid) || !canonicalTimestamp(processCreatedAt) || !localAbsolute(executable)) return null;
  return Object.freeze({ schemaVersion, role, pid, processCreatedAt, executable });
}

/** Read the identity of a worker this supervisor just spawned. Anything short of a complete,
 * matching record is `uncertain`: the caller must then stop and confirm its owned child, or
 * keep the stage reservation unresolved. It never claims no untracked worker exists. */
export async function captureWorkerIdentity(input: { pid: unknown; role: unknown; executable: unknown }, host: ProcessQueryHost = defaultProcessQueryHost): Promise<CaptureResult> {
  const pid = input.pid, role = input.role, executable = input.executable;
  if (!validPid(pid) || !validRole(role) || !localAbsolute(executable)) return { status: 'uncertain', reason: 'identity-invalid' };
  const seen = await observe(host, pid);
  if (seen.kind === 'failed') return { status: 'uncertain', reason: seen.reason };
  if (seen.kind === 'absent') return { status: 'uncertain', reason: 'pid-absent' };
  if (seen.created === null || seen.executable === null) return { status: 'uncertain', reason: 'metadata-inaccessible' };
  if (!sameExecutable(seen.executable, executable)) return { status: 'uncertain', reason: 'executable-mismatch' };
  return { status: 'captured', identity: Object.freeze({ schemaVersion: 2, role, pid, processCreatedAt: seen.created, executable }) };
}

/** Host evidence about one recorded worker. Only an exact PID+creation-time comparison can yield
 * `recorded-worker-gone`; missing/legacy identity, partial metadata and every query fault are `unknown`. */
export async function attestRecordedWorker(recorded: unknown, host: ProcessQueryHost = defaultProcessQueryHost): Promise<Attestation> {
  if (recorded === undefined || recorded === null) return { verdict: 'unknown', reason: 'identity-missing' };
  const identity = parseWorkerIdentity(recorded); // Frozen copy taken before any await.
  if (!identity) return { verdict: 'unknown', reason: 'identity-invalid' };
  const seen = await observe(host, identity.pid);
  if (seen.kind === 'failed') return { verdict: 'unknown', reason: seen.reason };
  // The PID is unique among live processes; no live process with it means the recorded one ended.
  if (seen.kind === 'absent') return { verdict: 'recorded-worker-gone', reason: 'pid-absent' };
  if (seen.created === null) return { verdict: 'unknown', reason: 'metadata-inaccessible' };
  // CIM supplied microsecond metadata. Never interpret a cross-source precision
  // difference as PID reuse; only v2 compares exact native FILETIME timestamps.
  if (seen.created !== identity.processCreatedAt) return identity.schemaVersion === 2
    ? { verdict: 'recorded-worker-gone', reason: 'pid-reused' }
    : { verdict: 'unknown', reason: 'identity-conflict' };
  if (seen.executable === null) return { verdict: 'unknown', reason: 'metadata-inaccessible' };
  if (!sameExecutable(seen.executable, identity.executable)) return { verdict: 'unknown', reason: 'identity-conflict' };
  return { verdict: 'same-worker-running', reason: 'identity-matched' };
}
