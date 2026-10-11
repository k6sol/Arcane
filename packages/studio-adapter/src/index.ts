import { dirname } from 'node:path';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { discoverNativeStudioExecutable } from './discovery.js';
import { sessionLimits } from './policy.js';
import { NativeStudioSession } from './session.js';

export { discoverNativeStudioExecutable, type NativeStudioExecutable } from './discovery.js';
export { NativeStudioError, NATIVE_STUDIO_LIMITS, NATIVE_STUDIO_READ_METHODS, type NativeStudioReadArgs, type NativeStudioReadMethod } from './policy.js';
export type { NativeStudioSession, NativeStudioMetadata, NativeStudioInventoryItem, NativeStudioCapability } from './session.js';

/** Official SDK 1.32.1 stdio transport: absolute vetted exe, no arguments or shell/config overrides. */
export async function connectNativeStudio(options: { timeoutMs?: number; maxRequests?: number } = {}): Promise<NativeStudioSession> {
  const limits = sessionLimits(options);
  const executable = await discoverNativeStudioExecutable();
  const transport = new StdioClientTransport({
    command: executable.path, args: [], cwd: dirname(executable.path), stderr: 'ignore', maxBufferSize: 512 * 1024,
  });
  const session = new NativeStudioSession(transport, { kind: 'live', executable }, limits);
  try { await session.initialize(); return session; }
  catch (error) { await session.close(); throw error; }
}
