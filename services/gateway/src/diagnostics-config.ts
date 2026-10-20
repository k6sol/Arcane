export interface DiagnosticsConfig {retentionDays: number; perAccount: number; maxEvents: number; perMinute: number}
export function readDiagnosticsConfig(env: Record<string, string | undefined>, managedAccounts: boolean): DiagnosticsConfig | null {
  if (env.DIAGNOSTICS_ENABLED === undefined || env.DIAGNOSTICS_ENABLED === '' || env.DIAGNOSTICS_ENABLED === '0') return null;
  const fail = (name: string): never => {throw new Error('Invalid diagnostic configuration: ' + name);};
  if (env.DIAGNOSTICS_ENABLED !== '1' || !managedAccounts) fail('DIAGNOSTICS_ENABLED requires managed accounts');
  function number(name: string, fallback: number, min: number, max: number): number {
    const raw = env[name], value = raw === undefined || raw === '' ? fallback : Number(raw);
    if (!Number.isSafeInteger(value) || value < min || value > max) fail(name);
    return value;
  }
  return {retentionDays: number('DIAGNOSTICS_RETENTION_DAYS', 30, 1, 30), perAccount: number('DIAGNOSTICS_ACCOUNT_EVENTS', 10000, 1, 10000),
    maxEvents: number('DIAGNOSTICS_MAX_EVENTS', 100000, 1, 100000), perMinute: number('DIAGNOSTICS_PER_MINUTE', 60, 1, 120)};
}
