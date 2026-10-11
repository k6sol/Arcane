import type { Connection, Effort, Selection } from '../../../packages/protocol/src/providers.js';
interface State { connections: Connection[]; selection: Selection | null; busy: boolean; warnings: string[]; inferenceRuns: number }
const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const provider = el<HTMLSelectElement>('provider'), model = el<HTMLSelectElement>('model'), effort = el<HTMLSelectElement>('effort');
const status = el('status'), refresh = el<HTMLButtonElement>('refresh'), save = el<HTMLButtonElement>('save');
const fragment = location.hash.slice(1);
let token = /^[a-f0-9]{64}$/.test(fragment) ? fragment : '';
// This is a narrow local lab token, not a provider credential. Tab-scoped storage
// permits refresh without leaving a reusable token in the address bar/history.
try {
  if (token) sessionStorage.setItem('arcane-lab-session', token);
  else token = sessionStorage.getItem('arcane-lab-session') ?? '';
} catch { /* A storage-disabled tab can still use the original session link. */ }
history.replaceState(null, '', location.pathname);
let state: State = { connections: [], selection: null, busy: false, warnings: [], inferenceRuns: 0 };
let busy = false;
async function api<T>(path: string, input?: unknown): Promise<T> {
  const response = await fetch(path, { method: input === undefined ? 'GET' : 'POST', headers: { Authorization: 'Bearer ' + token, ...(input === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.message ?? data.error ?? 'Local request failed.');
  return data as T;
}
function option(select: HTMLSelectElement, value: string, label: string) { const node = document.createElement('option'); node.value = value; node.textContent = label; select.append(node); }
function active() { return state.connections.find(c => c.provider === provider.value); }
function effortsForModel(previous = '') {
  effort.replaceChildren(); option(effort, '', 'Choose effort explicitly');
  const item = active()?.models.find(m => m.id === model.value);
  for (const value of item?.efforts ?? []) option(effort, value, value === 'ultra' ? 'Ultra' : value);
  if (item?.efforts.includes(previous as Effort)) effort.value = previous;
}
function renderProvider() {
  const oldModel = model.value, oldEffort = effort.value;
  model.replaceChildren(); option(model, '', 'Choose a model');
  const connection = active();
  for (const item of connection?.models ?? []) option(model, item.id, item.label);
  const desired = state.selection?.provider === provider.value ? state.selection.model : oldModel;
  if (connection?.models.some(m => m.id === desired)) model.value = desired;
  effortsForModel(state.selection?.provider === provider.value ? state.selection.effort : oldEffort);
  el('login-command').textContent = provider.value === 'codex' ? 'codex login' : 'claude auth login';
  const features = el('features'); features.replaceChildren();
  for (const feature of connection?.features ?? []) {
    const card = document.createElement('article'); card.className = 'feature-card';
    const heading = document.createElement('h3'); heading.textContent = feature.label;
    const badge = document.createElement('span'); badge.className = 'state ' + feature.state; badge.textContent = feature.state.replaceAll('-', ' ');
    const reason = document.createElement('p'); reason.textContent = feature.reason;
    card.append(heading, badge, reason); features.append(card);
  }
  const list = el('warnings'); list.replaceChildren();
  for (const warning of [...state.warnings, ...(connection?.warnings ?? [])]) { const item = document.createElement('li'); item.textContent = warning; list.append(item); }
}
function render() {
  const cards = el('connections'); cards.replaceChildren();
  for (const connection of state.connections) {
    const card = document.createElement('article'); card.className = 'provider-card';
    const top = document.createElement('div'); top.className = 'provider-top';
    const heading = document.createElement('h3'); heading.textContent = connection.provider === 'codex' ? 'Codex' : 'Claude Code';
    const badge = document.createElement('span'); badge.className = 'state ' + (connection.auth === 'subscription' ? 'available' : 'unverified'); badge.textContent = connection.auth;
    const detail = document.createElement('p'); detail.textContent = connection.installed ? 'CLI ' + (connection.version ?? 'unknown') + ' · Plan ' + (connection.plan ?? 'unavailable') : 'Native executable not found';
    const models = document.createElement('p'); models.textContent = connection.models.length + (connection.provider === 'codex' ? ' catalogue models · request entitlement unverified' : ' native aliases · model support unverified');
    top.append(heading, badge); card.append(top, detail, models); cards.append(card);
  }
  if (state.selection) { provider.value = state.selection.provider; el('saved').textContent = 'Saved: ' + state.selection.provider + ' / ' + state.selection.model + ' / ' + state.selection.effort + ' · requested only, not applied to a task'; }
  renderProvider();
}
async function probe() {
  if (busy) return; busy = true; refresh.disabled = true; save.disabled = true;
  status.className = ''; status.textContent = 'Reading native login and catalogue metadata. No inference…';
  try { state = await api<State>('/v1/probe', {}); render(); status.textContent = 'Native metadata refreshed. No credentials exported or inference run.'; }
  catch (error) { status.className = 'error'; status.textContent = error instanceof Error ? error.message : 'Probe failed.'; }
  finally { busy = false; refresh.disabled = false; save.disabled = false; }
}
provider.addEventListener('change', renderProvider); model.addEventListener('change', () => effortsForModel()); refresh.addEventListener('click', () => { void probe(); });
el<HTMLFormElement>('selection').addEventListener('submit', event => {
  event.preventDefault(); if (busy) return;
  const connection = active(); if (!connection) return;
  busy = true; save.disabled = true;
  void api<{selection: Selection}>('/v1/selection', { provider: provider.value, model: model.value, effort: effort.value, connectionRevision: connection.revision })
    .then(result => { state.selection = result.selection; render(); status.className = ''; status.textContent = 'Exact preference saved. No task launched and no fallback selected.'; })
    .catch(error => { status.className = 'error'; status.textContent = error instanceof Error ? error.message : 'Save failed.'; })
    .finally(() => { busy = false; save.disabled = false; });
});
if (!/^[a-f0-9]{64}$/.test(token)) { status.className = 'error'; status.textContent = 'Open the session link printed by npm run start:lab. This tab has no session token.'; refresh.disabled = true; save.disabled = true; }
else void api<State>('/v1/state').then(data => { state = data; render(); return probe(); }).catch(error => { status.className = 'error'; status.textContent = String(error); });

