import type { Connection, Effort, FeatureState, Selection } from '../../../packages/protocol/src/providers.js';
interface State { connections: Connection[]; selection: Selection | null; busy: boolean; warnings: string[]; inferenceRuns: number }
const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const provider = el<HTMLSelectElement>('provider'), model = el<HTMLSelectElement>('model'), effort = el<HTMLSelectElement>('effort');
const status = el('status'), refresh = el<HTMLButtonElement>('refresh'), save = el<HTMLButtonElement>('save');
const authLabels: Record<Connection['auth'], string> = { subscription: 'Subscription sign-in reported', 'api-or-cloud': 'API / cloud sign-in reported', 'signed-out': 'Signed out', unknown: 'Sign-in unverified' };
const featureLabels: Record<FeatureState, string> = { available: 'Available in lab', 'native-handoff': 'Use native client', 'requires-setup': 'Setup required', unsupported: 'Unsupported', unverified: 'Unverified' };
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
function updateControls() {
  const connection = active(), item = connection?.models.find(m => m.id === model.value);
  provider.disabled = busy;
  model.disabled = busy || !connection?.models.length;
  effort.disabled = busy || !item?.efforts.length;
  save.disabled = busy || !connection?.installed || connection.auth !== 'subscription' || !item?.efforts.includes(effort.value as Effort);
  el('selection-help').textContent = busy ? 'Wait for the current local request to finish.'
    : !/^[a-f0-9]{64}$/.test(token) ? 'Open provider connections from Arcane Settings, or use the local launcher session link.'
    : !connection ? 'Refresh native status to discover model and effort choices.'
    : !connection.installed ? 'Install this provider CLI, sign in from your terminal, then refresh native status.'
    : connection.auth !== 'subscription' ? 'Saving requires a reported subscription sign-in. Complete the native login and refresh; API / cloud sign-in is separate.'
    : !connection.models.length ? 'No models were reported. Review the connection warnings, then refresh native status.'
    : !item ? 'Choose a reported model, then choose a reasoning effort.'
    : !effort.value ? 'Choose a reasoning effort to save this exact preference.' : 'Ready to save your requested model and effort. No task will be started.';
}
function effortsForModel(previous = '') {
  effort.replaceChildren();
  const item = active()?.models.find(m => m.id === model.value);
  option(effort, '', item ? 'Choose effort explicitly' : 'Choose a model first');
  for (const value of item?.efforts ?? []) option(effort, value, value === 'ultra' ? 'Ultra' : value);
  if (item?.efforts.includes(previous as Effort)) effort.value = previous;
  updateControls();
}
function renderProvider() {
  const oldModel = model.value, oldEffort = effort.value;
  const connection = active();
  model.replaceChildren(); option(model, '', connection?.models.length ? 'Choose a model' : 'No models reported');
  for (const item of connection?.models ?? []) option(model, item.id, item.label);
  const desired = state.selection?.provider === provider.value ? state.selection.model : oldModel;
  if (connection?.models.some(m => m.id === desired)) model.value = desired;
  effortsForModel(state.selection?.provider === provider.value ? state.selection.effort : oldEffort);
  el('login-command').textContent = provider.value === 'codex' ? 'codex login' : 'claude auth login';
  const features = el('features'); features.replaceChildren();
  for (const feature of connection?.features ?? []) {
    const card = document.createElement('article'); card.className = 'feature-card';
    const heading = document.createElement('h3'); heading.textContent = feature.label;
    const badge = document.createElement('span'); badge.className = 'state ' + feature.state; badge.textContent = featureLabels[feature.state];
    const reason = document.createElement('p'); reason.textContent = feature.reason;
    card.append(heading, badge, reason); features.append(card);
  }
  if (!features.childElementCount) { const message = document.createElement('p'); message.className = 'empty'; message.textContent = 'No feature metadata reported for this provider. Refresh native status to check.'; features.append(message); }
  const list = el('warnings'); list.replaceChildren();
  for (const warning of [...state.warnings, ...(connection?.warnings ?? [])]) { const item = document.createElement('li'); item.textContent = warning; list.append(item); }
}
function render() {
  const cards = el('connections'); cards.replaceChildren();
  for (const connection of state.connections) {
    const card = document.createElement('article'); card.className = 'provider-card';
    const top = document.createElement('div'); top.className = 'provider-top';
    const heading = document.createElement('h3'); heading.textContent = connection.provider === 'codex' ? 'Codex' : 'Claude Code';
    const badge = document.createElement('span'); badge.className = 'state ' + (connection.auth === 'subscription' ? 'available' : 'unverified'); badge.textContent = authLabels[connection.auth];
    const detail = document.createElement('p'); detail.textContent = connection.installed ? 'CLI version: ' + (connection.version ?? 'not reported') + ' · Reported plan: ' + (connection.plan ?? 'not reported') : 'Native CLI not found. Install it on this computer, then restart Arcane and refresh.';
    const models = document.createElement('p'); models.textContent = connection.models.length ? connection.models.length + (connection.provider === 'codex' ? ' catalogue models · account access unverified' : ' native aliases · model support unverified') : 'No models reported.';
    top.append(heading, badge); card.append(top, detail, models); cards.append(card);
  }
  if (!cards.childElementCount) { const message = document.createElement('p'); message.className = 'empty'; message.textContent = 'No provider metadata reported. Refresh native status to check installation and sign-in.'; cards.append(message); }
  if (state.selection) { provider.value = state.selection.provider; el('saved').textContent = 'Saved request: ' + state.selection.provider + ' / ' + state.selection.model + ' / ' + state.selection.effort + ' · not applied to a task'; }
  renderProvider();
}
async function probe() {
  if (busy) return; busy = true; refresh.disabled = true; updateControls();
  status.className = ''; status.setAttribute('aria-busy', 'true'); status.textContent = 'Reading native sign-in and catalogue metadata. No inference is run.';
  try { state = await api<State>('/v1/probe', {}); render(); status.textContent = 'Native metadata refreshed. No credentials exported or inference run.'; }
  catch (error) { status.className = 'error'; status.textContent = error instanceof Error ? error.message : 'Probe failed.'; }
  finally { busy = false; refresh.disabled = false; status.setAttribute('aria-busy', 'false'); updateControls(); }
}
provider.addEventListener('change', renderProvider); model.addEventListener('change', () => effortsForModel()); effort.addEventListener('change', updateControls); refresh.addEventListener('click', () => { void probe(); });
el<HTMLFormElement>('selection').addEventListener('submit', event => {
  event.preventDefault(); if (busy || save.disabled) return;
  const connection = active(); if (!connection) return;
  busy = true; refresh.disabled = true; updateControls();
  void api<{selection: Selection}>('/v1/selection', { provider: provider.value, model: model.value, effort: effort.value, connectionRevision: connection.revision })
    .then(result => { state.selection = result.selection; render(); status.className = ''; status.textContent = 'Exact preference saved. No task launched and no fallback selected.'; })
    .catch(error => { status.className = 'error'; status.textContent = error instanceof Error ? error.message : 'Save failed.'; })
    .finally(() => { busy = false; refresh.disabled = false; updateControls(); });
});
updateControls();
// Mark the selected in-page section; the URL fragment carries the session and is never used for navigation state.
const sections = typeof document.querySelectorAll === 'function' ? [...document.querySelectorAll<HTMLAnchorElement>('.sidebar nav a')] : [];
const current = (link: HTMLAnchorElement | undefined) => { for (const item of sections) item.toggleAttribute('aria-current', item === link); link?.setAttribute('aria-current', 'page'); };
for (const link of sections) link.addEventListener('click', () => current(link));
current(sections[0]);
if (!/^[a-f0-9]{64}$/.test(token)) { status.className = 'error'; status.textContent = 'Open provider connections from Arcane Settings, or use the session link printed by npm run start:lab. This tab has no valid local session.'; refresh.disabled = true; save.disabled = true; }
else void api<State>('/v1/state').then(data => { state = data; render(); return probe(); }).catch(error => { status.className = 'error'; status.textContent = String(error); });
