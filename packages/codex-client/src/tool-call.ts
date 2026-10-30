import { redactNativeHistoryText } from './history.js';
import { types as nodeTypes } from 'node:util';
import { summarizeMcpToolFailure } from './tool-failure.js';
import type { McpToolCallSummary, McpToolCallArgs } from './types.js';

/**
 * Bounds for the public live tool identity. Only a fixed allowlist of display fields is ever copied; script sources,
 * property values, asset payloads and every unknown argument are dropped, never truncated into view.
 */
export const MCP_TOOL_SUMMARY_LIMITS = Object.freeze({
  maxServer: 64, maxTool: 128, maxText: 100, maxRoot: 64, maxSegments: 16, maxProperties: 6, maxArgsBytes: 2048,
});
const SERVER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const TOOL = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const PROPERTY = /^[A-Za-z]{1,32}$/;
const plain = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !nodeTypes.isProxy(value) && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
/** Own enumerable data value only; getters and inherited fields are never invoked or read. */
function own(value: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && descriptor.enumerable && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
}
/** Short single-line display text with no credential-shaped content; anything else is dropped (not shortened). */
function safeText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max || /[\x00-\x1f\x7f\u2028\u2029]/.test(trimmed)) return null;
  try { return redactNativeHistoryText(trimmed) === trimmed ? trimmed : null; } catch { return null; }
}
function safeRef(value: unknown): McpToolCallArgs['ref'] | null {
  if (!plain(value)) return null;
  const root = safeText(own(value, 'root'), MCP_TOOL_SUMMARY_LIMITS.maxRoot);
  if (!root) return null;
  // Full refs carry pathSegments; compact refs returned to the model carry one slash-joined path string instead.
  const segments = own(value, 'pathSegments'), path = own(value, 'path');
  let raw: unknown = segments;
  if (segments !== undefined && path !== undefined) return { root, pathSegments: [] }; // Ambiguous: keep the root only.
  if (segments === undefined && typeof path === 'string') {
    const max = MCP_TOOL_SUMMARY_LIMITS.maxSegments * (MCP_TOOL_SUMMARY_LIMITS.maxText + 1);
    if (path.length > max) return { root, pathSegments: [] };
    raw = path === '' ? [] : path.split('/');
  }
  const pathSegments: string[] = [];
  if (Array.isArray(raw)) {
    if (raw.length > MCP_TOOL_SUMMARY_LIMITS.maxSegments) return { root, pathSegments: [] };
    for (let i = 0; i < raw.length; i++) {
      const part = safeText(own(raw as unknown as Record<string, unknown>, String(i)), MCP_TOOL_SUMMARY_LIMITS.maxText);
      if (!part) return { root, pathSegments: [] };
      pathSegments.push(part);
    }
  }
  return { root, pathSegments };
}
/** Allowlisted display arguments for an Arcane tool call, or null when nothing safe remains. */
export function summarizeArcaneToolArgs(value: unknown): McpToolCallArgs | null {
  if (!plain(value)) return null;
  const args: McpToolCallArgs = {};
  const ref = safeRef(own(value, 'ref')), parent = safeRef(own(value, 'parent'));
  if (ref) args.ref = ref;
  if (parent) args.parent = parent;
  const root = safeText(own(value, 'root'), MCP_TOOL_SUMMARY_LIMITS.maxRoot);
  if (root) args.root = root;
  for (const key of ['query', 'name', 'className', 'kind'] as const) {
    const text = safeText(own(value, key), key === 'className' ? 64 : MCP_TOOL_SUMMARY_LIMITS.maxText);
    if (text) args[key] = text;
  }
  const enabled = own(value, 'enabled');
  if (typeof enabled === 'boolean') args.enabled = enabled;
  // Property NAMES only (Size, Color); values never leave the provider process.
  const properties = own(value, 'properties');
  if (plain(properties)) {
    const names = Object.keys(properties).filter(key => PROPERTY.test(key)).slice(0, MCP_TOOL_SUMMARY_LIMITS.maxProperties);
    if (names.length) args.properties = Object.fromEntries(names.map(key => [key, true]));
  }
  if (!Object.keys(args).length || Buffer.byteLength(JSON.stringify(args)) > MCP_TOOL_SUMMARY_LIMITS.maxArgsBytes) return null;
  return args;
}
/**
 * Public identity of one native MCP tool call item (server, tool, display arguments). Arguments are summarised only for
 * the Arcane server; other servers expose their validated names alone. Malformed identities yield null.
 */
export function summarizeMcpToolCall(item: Record<string, unknown>): McpToolCallSummary | null {
  if (!plain(item)) return null;
  const server = own(item, 'server'), tool = own(item, 'tool');
  if (typeof server !== 'string' || !SERVER.test(server) || typeof tool !== 'string' || !TOOL.test(tool)) return null;
  if (safeText(server, MCP_TOOL_SUMMARY_LIMITS.maxServer) !== server || safeText(tool, MCP_TOOL_SUMMARY_LIMITS.maxTool) !== tool) return null;
  const failure=summarizeMcpToolFailure(item);
  return { server, tool, args: server === 'arcane' ? summarizeArcaneToolArgs(own(item, 'arguments')) : null, ...(failure?{failure}:{}) };
}
