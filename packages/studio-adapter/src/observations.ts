import { createHash } from 'node:crypto';
import { connectNativeStudio, NativeStudioError } from './index.js';
import type { NativeStudioMetadata } from './session.js';

/** Saved observations exclude script source, properties, attributes, console logs and stderr. */
export function sanitizeObservationText(value: string): string {
  return value
    .replace(/(["'](?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|password|secret)["']\s*:\s*["'])[^"'\r\n]*(["'])/gi, '$1[REDACTED]$2')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:sk-|ghp_|github_pat_)[A-Za-z0-9_-]{8,}/g, '[REDACTED]')
    .replace(/((?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|password|secret)\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
}
function schemaData(value: unknown, depth = 0): unknown {
  if (depth > 32) return '[DEPTH LIMIT]';
  if (Array.isArray(value)) return value.map(item => schemaData(item, depth + 1));
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).filter(([key]) => !['description', 'title', 'examples', 'default'].includes(key)).map(([key, item]) => [key, schemaData(item, depth + 1)]));
  return value;
}
function capabilityObservation(metadata: NativeStudioMetadata) {
  return {
    observedAt: metadata.observedAt, server: metadata.server, serverCapabilities: metadata.serverCapabilities,
    toolCount: metadata.tools.length,
    tools: metadata.tools.map(tool => ({
      name: tool.name, allowed: tool.allowed, blockedReason: tool.blockedReason,
      inputSchema: schemaData(tool.inputSchema), annotations: tool.annotations,
    })).sort((a, b) => a.name.localeCompare(b.name)),
  };
}
export async function captureNativeStudioChecks(studio_id?: string) {
  if (studio_id !== undefined && !/^[A-Za-z0-9_-]{1,128}$/.test(studio_id))
    throw new NativeStudioError('STUDIO_ARGUMENTS', 'Supply an exact studio_id, with no inferred target.');
  const session = await connectNativeStudio({ timeoutMs: 10_000, maxRequests: 32 });
  const startedAt = new Date().toISOString();
  try {
    const metadata = session.metadata();
    const inventory = await session.listStudios();
    let targetedRead: Record<string, unknown> = { status: 'not_requested' };
    if (studio_id !== undefined) {
      try {
        const result = await session.read('get_studio_state', { studio_id });
        const texts = result.content.flatMap(item => item.type === 'text' ? [item.text] : []);
        targetedRead = {
          method: 'get_studio_state', studio_id, status: result.isError ? 'server_error' : 'succeeded',
          text: texts.map(text => sanitizeObservationText(text).slice(0, 2048)),
          responseBytes: Buffer.byteLength(JSON.stringify(result), 'utf8'),
          responseSha256: createHash('sha256').update(JSON.stringify(result)).digest('hex'),
        };
      } catch (error) {
        targetedRead = { method: 'get_studio_state', studio_id, status: 'refused_or_failed',
          error: error instanceof NativeStudioError ? error.code : 'STUDIO_REQUEST_FAILED' };
      }
    }
    await session.close();
    const final = session.metadata();
    const executable = metadata.provenance.kind === 'live' ? metadata.provenance.executable : undefined;
    return {
      evidenceKind: 'live-built-in-studio-mcp', startedAt, finishedAt: new Date().toISOString(),
      sdk: { name: '@modelcontextprotocol/sdk', version: metadata.sdkVersion },
      executable: executable ? {
        path: executable.path.replace(/^.*[\\/]Roblox[\\/]/i, '%LOCALAPPDATA%\\Roblox\\'),
        sha256: executable.sha256, signatureStatus: executable.signatureStatus, signer: executable.signer,
        discoveredFrom: executable.discoveredFrom,
      } : undefined,
      launch: { transport: 'stdio', shell: false, windowsHide: true, args: [], launcherExecuted: false },
      capabilityInventory: capabilityObservation(metadata),
      observations: {
        list_roblox_studios: { status: 'succeeded', studios: inventory.map(item => ({ id: item.id, name: sanitizeObservationText(item.name).slice(0, 200) })) },
        targetedRead,
      },
      lifecycle: { requestsUsed: final.requestsUsed, limits: final.limits, connectedAfterClose: final.connected, closed: true, automaticRetries: 0 },
      mutationCalls: 0,
      excludes: ['script source', 'instance properties', 'attributes', 'console logs', 'stderr', 'provider credentials'],
      fixtureTests: { status: 'not_run_by_this_capture', evidenceKind: 'fixture', source: 'tests/unit/native-studio.test.ts' },
    };
  } finally { await session.close(); }
}
