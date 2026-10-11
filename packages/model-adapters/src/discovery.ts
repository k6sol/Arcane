import { randomUUID } from 'node:crypto';
import { ArcaneError, type Connection } from '../../protocol/src/providers.js';
import { boundedCommand, locateNativeCli } from './process.js';
import { ReadonlyCodexRpc } from './codex-rpc.js';
import { claudeModelsFromHelp, emptyConnection, featuresFor, normalizeClaudeAuth, normalizeCodexAuth, normalizeCodexModels, reconcileFeatureStates } from './catalogue.js';

const authOverrides = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'];
export async function discoverCodex(cwd: string): Promise<Connection> {
  const result = emptyConnection('codex');
  const command = await locateNativeCli('codex');
  if (!command) { result.warnings.push('Native codex executable was not found on PATH.'); return result; }
  result.installed = true; result.features = featuresFor('codex', true);
  let rpc: ReadonlyCodexRpc | undefined;
  try {
    const version = await boundedCommand({ command, args: ['--version'], cwd });
    if (version.exitCode !== 0) throw new ArcaneError('CLI_VERSION', 'Codex version check failed.');
    result.version = /codex-cli\s+([0-9A-Za-z.+-]+)/.exec(version.stdout)?.[1] ?? 'unknown';
    rpc = new ReadonlyCodexRpc({ command, args: ['app-server', '--listen', 'stdio://'], cwd });
    await rpc.initialize();
    Object.assign(result, normalizeCodexAuth(await rpc.request('account/read', { refreshToken: false })));
    let cursor: string | null = null;
    const seenCursors = new Set<string>();
    const seenModels = new Set<string>();
    for (let page = 0; page < 5; page++) {
      const parsed = normalizeCodexModels(await rpc.request('model/list', { limit: 20, includeHidden: false, ...(cursor ? { cursor } : {}) }));
      for (const model of parsed.models) {
        if (seenModels.has(model.id)) throw new ArcaneError('CATALOGUE', 'Model repeated across catalogue pages.');
        seenModels.add(model.id); result.models.push(model);
      }
      cursor = parsed.nextCursor;
      if (!cursor) break;
      if (seenCursors.has(cursor)) throw new ArcaneError('CATALOGUE', 'Repeated catalogue cursor.');
      seenCursors.add(cursor);
      if (page === 4) result.warnings.push('Catalogue capped at five pages; no inference has run.');
    }
    if (process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY || process.env.OPENAI_BASE_URL) result.warnings.push('Provider environment overrides are present. Future run preflight must confirm actual authentication and billing.');
  } catch (error) {
    result.models = [];
    result.warnings.push(error instanceof ArcaneError ? error.code + ': discovery unavailable; no fallback or inference attempted.' : 'Native discovery failed; account details were not logged.');
  } finally { rpc?.close(); }
  result.observedAt = new Date().toISOString(); result.revision = randomUUID();
  reconcileFeatureStates(result);
  return result;
}
export async function discoverClaude(cwd: string): Promise<Connection> {
  const result = emptyConnection('claude');
  const command = await locateNativeCli('claude');
  if (!command) { result.warnings.push('Native claude executable was not found on PATH.'); return result; }
  result.installed = true; result.features = featuresFor('claude', true);
  try {
    const version = await boundedCommand({ command, args: ['--version'], cwd });
    if (version.exitCode !== 0) throw new ArcaneError('CLI_VERSION', 'Claude version check failed.');
    result.version = /^([0-9A-Za-z.+-]+)\s/.exec(version.stdout)?.[1] ?? 'unknown';
    const auth = await boundedCommand({ command, args: ['auth', 'status', '--json'], cwd });
    if (auth.exitCode !== 0) { result.auth = 'signed-out'; result.warnings.push('Native authentication status did not return a signed-in result.'); }
    else Object.assign(result, normalizeClaudeAuth(JSON.parse(auth.stdout)));
    const help = await boundedCommand({ command, args: ['--help'], cwd });
    if (help.exitCode === 0) result.models = claudeModelsFromHelp(help.stdout);
    result.warnings.push('Native aliases/effort flags are CLI choices, not per-account/model entitlement or proof of applied effort.');
    if (authOverrides.some(name => process.env[name])) result.warnings.push('Authentication/provider environment overrides are present; subscription billing cannot be assumed.');
    result.warnings.push('Third-party embedded subscription use needs provider approval. This lab does not invoke Claude inference or export login tokens.');
  } catch (error) {
    result.models = []; result.auth = 'unknown';
    result.warnings.push(error instanceof ArcaneError ? error.code + ': native status probe unavailable.' : 'Native status could not be parsed; raw account output was not logged.');
  }
  result.observedAt = new Date().toISOString(); result.revision = randomUUID();
  reconcileFeatureStates(result);
  return result;
}
export async function discoverProviders(cwd: string): Promise<Connection[]> {
  // Independent bounded metadata reads only; no multiple-agent inference.
  return Promise.all([discoverCodex(cwd), discoverClaude(cwd)]);
}

