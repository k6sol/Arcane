import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';

export const NATIVE_STUDIO_LIMITS = Object.freeze({
  argumentBytes: 256 * 1024, resultBytes: 512 * 1024, sourceBytes: 100 * 1024,
  tools: 128, toolPages: 4, capabilityBytes: 256 * 1024, studios: 64, defaultTimeoutMs: 10_000,
  maximumTimeoutMs: 15_000, defaultRequests: 64, maximumRequests: 256,
});
export const NATIVE_STUDIO_READ_METHODS = Object.freeze([
  'get_studio_state', 'search_game_tree', 'inspect_instance', 'script_read',
  'script_search', 'script_grep', 'get_console_output',
] as const);
export type NativeStudioReadMethod = typeof NATIVE_STUDIO_READ_METHODS[number];
export class NativeStudioError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = 'NativeStudioError'; }
}
const studioId = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const text = (maximum: number) => z.string().min(1).max(maximum).refine(value => value.trim().length > 0 && !/[\u0000-\u001f]/.test(value));
const path = text(1024);
export const readSchemas = {
  get_studio_state: z.strictObject({ studio_id: studioId }),
  search_game_tree: z.strictObject({
    studio_id: studioId, datamodel_type: z.enum(['Edit', 'Client', 'Server']),
    path: path.optional(), instance_type: text(100).optional(), keywords: text(256).optional(),
    head_limit: z.number().int().min(1).max(200).default(100),
    max_depth: z.number().int().min(1).max(10).default(3),
  }),
  inspect_instance: z.strictObject({ studio_id: studioId, path }),
  script_read: z.strictObject({
    studio_id: studioId, target_file: path, should_read_entire_file: z.boolean().default(true),
    start_line_one_indexed: z.number().int().min(1).max(1_000_000).optional(),
    end_line_one_indexed_inclusive: z.number().int().min(1).max(1_000_000).optional(),
  }).superRefine((args, ctx) => {
    const start = args.start_line_one_indexed, end = args.end_line_one_indexed_inclusive;
    if (args.should_read_entire_file && (start !== undefined || end !== undefined))
      ctx.addIssue({ code: 'custom', message: 'Whole-file reads do not accept a line range.' });
    if (!args.should_read_entire_file && (start === undefined || end === undefined || end < start || end - start >= 500))
      ctx.addIssue({ code: 'custom', message: 'Supply an ordered inclusive range of at most 500 lines.' });
  }),
  script_search: z.strictObject({ studio_id: studioId, keywords: text(256) }),
  script_grep: z.strictObject({ studio_id: studioId, query: text(256) }),
  get_console_output: z.strictObject({ studio_id: studioId }),
} as const;
export type NativeStudioReadArgs = { [K in NativeStudioReadMethod]: z.input<typeof readSchemas[K]> };
export const requiredArguments: Record<NativeStudioReadMethod | 'list_roblox_studios', readonly string[]> = {
  list_roblox_studios: [], get_studio_state: ['studio_id'],
  search_game_tree: ['studio_id', 'datamodel_type'], inspect_instance: ['studio_id', 'path'],
  script_read: ['studio_id', 'target_file'], script_search: ['studio_id', 'keywords'],
  script_grep: ['studio_id', 'query'], get_console_output: ['studio_id'],
};
const optionalArguments: Partial<Record<NativeStudioReadMethod, readonly string[]>> = {
  search_game_tree: ['path', 'instance_type', 'keywords', 'head_limit', 'max_depth'],
  script_read: ['should_read_entire_file', 'start_line_one_indexed', 'end_line_one_indexed_inclusive'],
};
export function toolPolicy(tool: Tool): string | null {
  if (tool.name !== 'list_roblox_studios' && !NATIVE_STUDIO_READ_METHODS.includes(tool.name as NativeStudioReadMethod)) return 'not_read_allowlisted';
  if (tool.annotations?.readOnlyHint !== true || tool.annotations?.destructiveHint === true) return 'read_only_annotation_missing';
  const name = tool.name as keyof typeof requiredArguments;
  const schema = tool.inputSchema, properties = schema.properties ?? {}, required = schema.required ?? [];
  if (schema.type !== 'object' || !requiredArguments[name].every(key => required.includes(key))) return 'required_arguments_changed';
  const accepted = [...requiredArguments[name], ...(optionalArguments[name as NativeStudioReadMethod] ?? [])];
  if (required.some(key => !accepted.includes(key))) return 'unknown_required_argument';
  for (const key of requiredArguments[name]) {
    const property = properties[key] as { type?: unknown } | undefined;
    if (property?.type !== 'string') return 'required_argument_type_changed';
  }
  return null;
}
export function parseReadArguments(method: string, input: unknown): Record<string, unknown> & { studio_id: string } {
  if (!NATIVE_STUDIO_READ_METHODS.includes(method as NativeStudioReadMethod))
    throw new NativeStudioError('STUDIO_READ_ONLY', 'This adapter exposes only its fixed read allowlist.');
  const result = readSchemas[method as NativeStudioReadMethod].safeParse(input);
  if (!result.success) throw new NativeStudioError('STUDIO_ARGUMENTS', 'Invalid read arguments. Supply an exact studio_id and only documented fields within their bounds.');
  if (Buffer.byteLength(JSON.stringify(result.data), 'utf8') > NATIVE_STUDIO_LIMITS.argumentBytes)
    throw new NativeStudioError('STUDIO_PAYLOAD_LIMIT', 'Read arguments exceed the byte limit.');
  return result.data;
}
export function sessionLimits(input: { timeoutMs?: number; maxRequests?: number } = {}) {
  const timeoutMs = input.timeoutMs ?? NATIVE_STUDIO_LIMITS.defaultTimeoutMs;
  const maxRequests = input.maxRequests ?? NATIVE_STUDIO_LIMITS.defaultRequests;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > NATIVE_STUDIO_LIMITS.maximumTimeoutMs ||
      !Number.isInteger(maxRequests) || maxRequests < 3 || maxRequests > NATIVE_STUDIO_LIMITS.maximumRequests)
    throw new NativeStudioError('STUDIO_LIMITS', 'Timeout and request budget must be bounded positive integers.');
  return { timeoutMs, maxRequests };
}
