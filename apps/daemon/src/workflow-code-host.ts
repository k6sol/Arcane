import { isAbsolute, resolve } from 'node:path';
import { types } from 'node:util';
import { ArcaneError } from '../../../packages/protocol/src/providers.js';
import type { WorkflowVerifier } from './workflow-service.js';
import {
  createWorkflowCodeVerifier, workflowCodeVerifierCapabilities, type WorkflowCodeVerifierOptions,
} from './workflow-code-verifier.js';

export type WorkflowCodeHostConfiguration = Omit<WorkflowCodeVerifierOptions, 'projectPath'>;
const KEYS = ['ARCANE_LUAU_COMPILER_PATH', 'ARCANE_LUAU_COMPILER_SHA256', 'ARCANE_LUAU_EVIDENCE_DIRECTORY'] as const;
function invalid(): never {
  throw new ArcaneError('WORKFLOW_CODE_CONFIGURATION', 'Luau verification requires a trusted absolute compiler path, its approved SHA-256 and an existing scoped evidence directory. No fallback was attempted.');
}
/** Trusted launcher environment only. Never call with HTTP, agent or recipe data. No filesystem/process work. */
export function workflowCodeHostConfiguration(environment: Readonly<NodeJS.ProcessEnv>): WorkflowCodeHostConfiguration | undefined {
  if (!environment || typeof environment !== 'object' || types.isProxy(environment)) invalid();
  const descriptors = KEYS.map(key => Object.getOwnPropertyDescriptor(environment, key));
  const values = descriptors.map(d => {
    if (d && !Object.hasOwn(d, 'value')) invalid();
    return d?.value as unknown;
  });
  if (values.every(value => value === undefined)) return undefined;
  if (values.some(value => typeof value !== 'string' || !value || value !== value.trim() || value !== value.normalize('NFKC') || /[\u0000-\u001f\u007f-\u009f]/u.test(value))) invalid();
  const [executablePath, digest, evidenceDirectory] = values as [string, string, string];
  if (!isAbsolute(executablePath) || resolve(executablePath) !== executablePath || executablePath.length > 2048 || /^(?:\\\\|\/\/)/.test(executablePath) || !/^[a-f0-9]{64}$/.test(digest)) invalid();
  const relative = evidenceDirectory.replaceAll('\\', '/');
  if (isAbsolute(relative) || Buffer.byteLength(relative) > 245 || relative.split('/').some(part => !part || part === '.' || part === '..' || /[<>:"|?*]|[. ]$/.test(part))) invalid();
  return Object.freeze({ evidenceDirectory: relative, compiler: Object.freeze({ executablePath, sha256: digest }) });
}
/** One project/lifetime adapter. Its live preflight state is authoritative even after invalidation. */
export async function createWorkflowCodeHostVerifier(projectPath: string, configuration: WorkflowCodeHostConfiguration): Promise<WorkflowVerifier> {
  if (!configuration || typeof configuration !== 'object' || types.isProxy(configuration)) invalid();
  const prototype: unknown = Object.getPrototypeOf(configuration);
  if (prototype !== Object.prototype && prototype !== null) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(configuration);
  if (Reflect.ownKeys(descriptors).length !== 2 || ['evidenceDirectory', 'compiler'].some(key =>
    !descriptors[key] || !Object.hasOwn(descriptors[key]!, 'value') || !descriptors[key]!.enumerable)) invalid();
  const compiler: unknown = descriptors.compiler!.value;
  if (!compiler || typeof compiler !== 'object' || types.isProxy(compiler)) invalid();
  const compilerPrototype: unknown = Object.getPrototypeOf(compiler);
  if (compilerPrototype !== Object.prototype && compilerPrototype !== null) invalid();
  const pin = Object.getOwnPropertyDescriptors(compiler);
  if (Reflect.ownKeys(pin).length !== 2 || ['executablePath', 'sha256'].some(key =>
    !pin[key] || !Object.hasOwn(pin[key]!, 'value') || !pin[key]!.enumerable)) invalid();
  const trusted = workflowCodeHostConfiguration({
    ARCANE_LUAU_COMPILER_PATH: pin.executablePath!.value as string,
    ARCANE_LUAU_COMPILER_SHA256: pin.sha256!.value as string,
    ARCANE_LUAU_EVIDENCE_DIRECTORY: descriptors.evidenceDirectory!.value as string,
  });
  if (!trusted) invalid();
  const adapter = await createWorkflowCodeVerifier({ projectPath, ...trusted });
  return Object.freeze({ action: adapter.action, verify: adapter.verify,
    available: () => workflowCodeVerifierCapabilities(adapter).some(capability => capability.id === 'local.code.verify' && capability.state === 'available'),
  });
}
