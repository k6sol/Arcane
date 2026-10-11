export type ProviderId = 'codex' | 'claude';
export type FeatureState = 'available' | 'native-handoff' | 'requires-setup' | 'unsupported' | 'unverified';
export type Effort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
export interface ModelOption {
  id: string;
  label: string;
  efforts: Effort[];
  defaultEffort: Effort | null;
  source: 'runtime-catalogue' | 'native-cli-alias';
  entitlement: 'unverified';
  inputModalities: string[];
}
export interface Feature {
  id: string;
  label: string;
  state: FeatureState;
  route: 'arcane-readonly' | 'native-client' | 'future-adapter';
  reason: string;
}
export interface Connection {
  provider: ProviderId;
  installed: boolean;
  version: string | null;
  auth: 'subscription' | 'api-or-cloud' | 'signed-out' | 'unknown';
  plan: string | null;
  models: ModelOption[];
  features: Feature[];
  warnings: string[];
  observedAt: string;
  revision: string;
}
export interface Selection {
  provider: ProviderId;
  model: string;
  effort: Effort;
  connectionRevision: string;
  savedAt: string;
  applied: false;
}
export class ArcaneError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = 'ArcaneError'; }
}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ArcaneError('INVALID_DATA', 'Expected an object.');
  return value as Record<string, unknown>;
}
export function boundedString(value: unknown, max = 160): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f]/.test(value)) {
    throw new ArcaneError('INVALID_DATA', 'Expected a bounded text value.');
  }
  return value;
}
export const efforts: readonly Effort[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

