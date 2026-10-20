import { randomUUID } from 'node:crypto';
import { ArcaneError, boundedString, efforts, object, type Connection, type Effort, type Feature, type ModelOption, type ProviderId } from '../../protocol/src/providers.js';

export function normalizeCodexModels(value: unknown): { models: ModelOption[]; nextCursor: string | null } {
  const response = object(value);
  if (!Array.isArray(response.data) || response.data.length > 100) throw new ArcaneError('CATALOGUE', 'Invalid model catalogue.');
  const models = response.data.filter(raw => object(raw).hidden !== true).map(raw => {
    const model = object(raw);
    const id = boundedString(model.model ?? model.id);
    const label = boundedString(model.displayName ?? id);
    if (!Array.isArray(model.supportedReasoningEfforts) || model.supportedReasoningEfforts.length > 16) throw new ArcaneError('CATALOGUE', 'Model did not report a bounded effort list.');
    const supported = model.supportedReasoningEfforts.map(rawEffort => {
      const effort = object(rawEffort).reasoningEffort;
      if (!efforts.includes(effort as Effort)) throw new ArcaneError('CATALOGUE', 'Unknown effort requires adapter review, not silent substitution.');
      return effort as Effort;
    });
    if (!supported.length || new Set(supported).size !== supported.length) throw new ArcaneError('CATALOGUE', 'Invalid effort choices.');
    const defaultEffort = supported.includes(model.defaultReasoningEffort as Effort) ? model.defaultReasoningEffort as Effort : null;
    const inputModalities = Array.isArray(model.inputModalities) ? model.inputModalities.map(v => boundedString(v, 32)) : [];
    return { id, label, efforts: supported, defaultEffort, inputModalities, source: 'runtime-catalogue', entitlement: 'unverified' } satisfies ModelOption;
  });
  if (new Set(models.map(m => m.id)).size !== models.length) throw new ArcaneError('CATALOGUE', 'Duplicate model identifiers.');
  return { models, nextCursor: response.nextCursor == null ? null : boundedString(response.nextCursor, 1024) };
}

export function normalizeCodexAuth(value: unknown): Pick<Connection, 'auth' | 'plan'> {
  const response = object(value);
  if (response.account == null) return { auth: 'signed-out', plan: null };
  const account = object(response.account);
  if (account.type === 'chatgpt') return { auth: 'subscription', plan: typeof account.planType === 'string' ? boundedString(account.planType, 64) : null };
  if (account.type === 'apiKey' || account.type === 'amazonBedrock') return { auth: 'api-or-cloud', plan: null };
  return { auth: 'unknown', plan: null };
}
export function normalizeClaudeAuth(value: unknown): Pick<Connection, 'auth' | 'plan'> {
  const response = object(value);
  if (response.loggedIn !== true) return { auth: 'signed-out', plan: null };
  if (response.authMethod === 'claude.ai' && response.apiProvider === 'firstParty') {
    return { auth: 'subscription', plan: typeof response.subscriptionType === 'string' ? boundedString(response.subscriptionType, 64) : null };
  }
  return { auth: response.authMethod ? 'api-or-cloud' : 'unknown', plan: null };
}

export function claudeModelsFromHelp(help: string): ModelOption[] {
  // These are aliases reported by this CLI, not an account-entitled model catalogue.
  const modelParagraph = /--model\s+<model>([\s\S]*?)(?:\n\s{2}--|\n\s{2}-[a-z])/m.exec(help)?.[1] ?? '';
  const aliases = [...modelParagraph.matchAll(/'([a-z][a-z0-9-]+)'/g)].map(m => m[1]!).filter(v => !v.startsWith('claude-'));
  const effortParagraph = /--effort\s+<level>([\s\S]*?)(?:\n\s{2}--|\n\s{2}-[a-z])/m.exec(help)?.[1] ?? '';
  const supported = efforts.filter(e => new RegExp('\\b' + e + '\\b').test(effortParagraph));
  if (!supported.length) return [];
  return [...new Set(aliases)].map(id => ({ id, label: id + ' · native alias', efforts: [...supported], defaultEffort: null, source: 'native-cli-alias', entitlement: 'unverified', inputModalities: [] }));
}
export function featuresFor(provider: ProviderId, installed: boolean): Feature[] {
  const setup = installed ? 'native-handoff' : 'requires-setup';
  return [
    { id: 'auth-status', label: 'Native CLI login status', state: installed ? 'available' : 'requires-setup', route: 'arcane-readonly', reason: 'Sanitized native status only; presence is not an inference or quota test.' },
    { id: 'model-selection', label: 'Model and effort selection', state: installed ? 'available' : 'requires-setup', route: 'arcane-readonly', reason: 'Saves the requested pair. It is not marked applied before a future runtime confirms it.' },
    { id: 'coding', label: 'Coding and debugging', state: setup, route: 'native-client', reason: 'Arcane chat uses the native provider. Sending requires current sign-in, a ready chat and the required project permissions; this metadata check does not verify a turn.' },
    { id: 'mcp', label: 'MCP tools and custom skills', state: installed ? 'unverified' : 'requires-setup', route: 'native-client', reason: 'Arcane provides a scoped MCP route and Studio plugin. This check does not verify the current tool configuration, Studio pairing or write permissions.' },
    { id: 'image-generation', label: 'Image generation and editing', state: provider === 'codex' ? setup : 'unverified', route: 'native-client', reason: provider === 'codex' ? 'Official native image workflow; installed feature/tool access and Arcane artifact return still need verification.' : 'Do not treat visual design or image understanding as a raster image-generation entitlement.' },
    { id: 'design', label: provider === 'claude' ? 'Claude Design and design systems' : 'Design and visual iteration', state: setup, route: 'native-client', reason: provider === 'claude' ? 'Documented native /design workflow. This installation and automated handoff have not been tested.' : 'Native reference-driven work; an embedded design surface has not been implemented.' },
    { id: 'browser', label: 'Browser and computer tools', state: 'requires-setup', route: 'native-client', reason: 'Needs actual installed tools, scoped permissions and runtime confirmation.' },
    { id: 'agents', label: 'Parallel agents', state: setup, route: 'native-client', reason: 'Client-owned feature; account limits are shared and live Studio writes need one owner.' },
    { id: 'plugins', label: 'Provider plugins and connectors', state: 'requires-setup', route: 'native-client', reason: 'Discovery, authorization and feature-specific adapters required; login alone does not install them.' },
    { id: 'voice-video', label: 'Voice and video features', state: 'unverified', route: 'future-adapter', reason: 'Separate platform feature/route; not presumed included in the CLI transport.' },
    { id: 'limits', label: 'Subscription usage and limits', state: 'unverified', route: 'future-adapter', reason: 'This lab reads no quota endpoint and does not estimate hidden allowance.' }
  ];
}
export function emptyConnection(provider: ProviderId): Connection {
  return { provider, installed: false, version: null, auth: 'unknown', plan: null, models: [], features: featuresFor(provider, false), warnings: [], observedAt: new Date().toISOString(), revision: randomUUID() };
}

export function reconcileFeatureStates(connection: Connection): void {
  connection.features = connection.features.map(feature => {
    if (feature.id === 'auth-status' && connection.auth === 'unknown') return { ...feature, state: 'unverified', reason: 'Native authentication metadata was unavailable; do not infer a successful connection.' };
    if (feature.id === 'model-selection' && (!connection.models.length || connection.auth !== 'subscription')) return { ...feature, state: 'requires-setup', reason: 'Requires current reported model choices and native subscription status. No pair was silently substituted.' };
    return feature;
  });
}

