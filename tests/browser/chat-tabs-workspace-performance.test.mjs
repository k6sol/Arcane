import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
import { chromium } from 'playwright-core';

// Opt-in Chromium fixture: no Electron profile, native bridge, provider, Studio or inference.
// Compile to a private outDir first; ARCANE_PERF_EMIT selects that directory.
test('chat tabs/workspace Chromium fixture profiles input, saves, snapshots and DOM churn', {
  skip: !process.env.ARCANE_PERF_EMIT,
}, async t => {
  const root = resolve(process.env.ARCANE_PERF_EMIT);
  const origin = 'https://arcane.fixture.invalid';
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.ARCANE_PERF_BROWSER ? { executablePath: process.env.ARCANE_PERF_BROWSER } : {}),
  });
  t.after(() => browser.close());
  const reports = [];
  for (let run = 0; run < 3; run++) {
    const page = await browser.newPage();
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) { await route.abort(); return; }
      if (url.pathname === '/') { await route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Arcane performance fixture</title>' }); return; }
      const path = resolve(root, '.' + url.pathname), child = relative(root, path);
      if (isAbsolute(child) || child.startsWith('..')) { await route.abort(); return; }
      try { await route.fulfill({ contentType: 'text/javascript', body: await readFile(path) }); }
      catch { await route.fulfill({ status: 404, body: '' }); }
    });
    await page.goto(origin);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.setSamplingInterval', { interval: 1000 });
    await cdp.send('Profiler.start');
    const report = await page.evaluate(async () => {
      const { ChatTabs, connectChatTabPreferences } = await import('/apps/desktop/src/chat-tabs.js');
      const { startWorkspaceShell } = await import('/apps/desktop/src/workspace-shell.js');
      const add = (tag, id, parent = document.body) => { const node = document.createElement(tag); node.id = id; parent.append(node); return node; };
      const mount = add('div', 'workspace-chat-tabs'); mount.setAttribute('role', 'tablist');
      add('button', 'workspace-new-chat');
      const composer = add('textarea', 'codex-composer');
      const previews = add('div', 'asset-previews');
      const summary = add('p', 'asset-job-summary'); add('p', 'preview-guide-status');
      for (let i = 0; i < 16; i++) add('canvas', '', add('figure', '', previews));
      let counts;
      const data = new Map();
      const tabs = new ChatTabs(document, text => { counts.cleanCalls++; return text; },
        { select: async () => true, close: async () => true, newChat: async () => true, openSaved: async () => true },
        { storage: { getItem: key => data.get(key) ?? null, setItem: (key, value) => { counts.writes++; data.set(key, value); } } });
      const state = { provider: 'codex', use: 'personal-local', projectPath: '/fixture/arcane', snapshot: null,
        lastSnapshot: null, connecting: false, closing: false, busy: false, actions: [], nativeHistory: null,
        nativeThreads: Array.from({ length: 256 }, (_, i) => ({ provider: 'codex', projectPath: '/fixture/arcane', threadId: 'fixture-' + i, sessionId: null, selection: { model: 'fixture-model', effort: 'low' } })) };
      counts = { writes: 0, cleanCalls: 0, snapshotReads: 0, snapshotMs: 0, tabRebuilds: 0, previewAttributeWrites: 0, inputs: 0, syncs: 0 };
      tabs.sync(state); for (let i = 1; i < 16; i++) { tabs.createDraft(); tabs.updateDraft('Fixture inactive draft '.repeat(200)); }
      tabs.activate(tabs.active().key); // Flush setup before the measured typing burst.
      tabs.mount(); tabs.render(false);
      const shell = startWorkspaceShell(document);
      // Models the public view's full clone/serialization cost; it is explicitly fixture data.
      const largeView = { state: { ...state, snapshot: { events: Array.from({ length: 1000 }, (_, i) => ({ seq: i, text: 'Fixture public history '.repeat(40) })) } }, fresh: true, persistence: 'browser-origin', preferredProvider: 'codex' };
      const listeners = new Set();
      const preferences = connectChatTabPreferences(document, {
        currentStateView() {
          counts.snapshotReads++; const start = performance.now();
          const value = JSON.parse(JSON.stringify(structuredClone(largeView)));
          counts.snapshotMs += performance.now() - start; return value;
        },
        setChatProviderPreference() {}, subscribeStateChange(listener) { listeners.add(listener); return () => listeners.delete(listener); },
      });
      const replace = mount.replaceChildren.bind(mount);
      mount.replaceChildren = (...nodes) => { counts.tabRebuilds++; return replace(...nodes); };
      const setAttribute = Element.prototype.setAttribute;
      Element.prototype.setAttribute = function (...args) { if (this.tagName === 'FIGURE') counts.previewAttributeWrites++; return setAttribute.apply(this, args); };
      counts = { writes: 0, cleanCalls: 0, snapshotReads: 0, snapshotMs: 0, tabRebuilds: 0, previewAttributeWrites: 0, inputs: 0, syncs: 0 };
      const durations = [], frames = [];
      composer.addEventListener('input', () => {
        const start = performance.now(); counts.inputs++;
        tabs.updateDraft(composer.value); tabs.render(false);
        for (const listener of listeners) listener();
        durations.push(performance.now() - start);
        requestAnimationFrame(() => frames.push(performance.now() - start));
      });
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const start = performance.now();
      for (let i = 0; i < 120; i++) {
        composer.value += 'x'; composer.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'x' }));
        await new Promise(resolve => setTimeout(resolve, 4));
      }
      await new Promise(resolve => setTimeout(resolve, 350));
      const saved = JSON.parse([...data.values()][0]);
      if (saved.tabs.find(tab => tab.key === saved.activeKey).draft !== 'x'.repeat(120)) throw new Error('The final fixture draft was not persisted.');
      const input = { ...counts };
      for (let i = 0; i < 50; i++) { tabs.sync(structuredClone(state)); counts.syncs++; tabs.render(false); }
      const idle = { writes: counts.writes - input.writes, cleanCalls: counts.cleanCalls - input.cleanCalls, tabRebuilds: counts.tabRebuilds - input.tabRebuilds };
      const beforeSelection = counts.tabRebuilds;
      for (let i = 0; i < 20; i++) { state.nativeThreads[0].selection.effort = i % 2 ? 'low' : 'high'; tabs.sync(state); tabs.render(false); }
      const selectionTabRebuilds = counts.tabRebuilds - beforeSelection;
      for (let i = 0; i < 50; i++) { summary.textContent = 'Fixture observed asset status ' + i; await new Promise(resolve => setTimeout(resolve, 0)); }
      const previewAttributeWrites = counts.previewAttributeWrites;
      const percentile = (values, fraction) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * fraction))];
      const result = { fixture: true, historyEvents: 1000, tabs: 16, savedThreads: 256, input, idle, selectionTabRebuilds, previewAttributeWrites,
        inputHandlerP50Ms: percentile(durations, .5), inputHandlerP95Ms: percentile(durations, .95), inputHandlerMaxMs: Math.max(...durations),
        inputToRafP95Ms: percentile(frames, .95), elapsedMs: performance.now() - start };
      preferences.cleanup(); shell.cleanup(); tabs.stop(); Element.prototype.setAttribute = setAttribute;
      return result;
    });
    const { profile } = await cdp.send('Profiler.stop');
    const nodes = new Map(profile.nodes.map(node => [node.id, node]));
    const samples = new Map();
    for (let i = 0; i < (profile.samples?.length ?? 0); i++) {
      const frame = nodes.get(profile.samples[i]).callFrame;
      const name = frame.functionName || '(anonymous)';
      samples.set(name, (samples.get(name) ?? 0) + (profile.timeDeltas?.[i] ?? 0) / 1000);
    }
    report.cpuSampleMs = [...samples.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
    reports.push(report);
    if (process.env.ARCANE_PERF_REPORT) await writeFile(process.env.ARCANE_PERF_REPORT + '.cpu-' + run + '.json', JSON.stringify(profile));
    await page.close();
    if (process.env.ARCANE_PERF_BASELINE !== '1') {
      assert.equal(report.input.inputs, 120);
      assert.ok(report.input.writes <= 2, 'rapid input coalesces preferences writes');
      assert.ok(report.input.snapshotReads <= 15, 'provider restore coalesces full public view reads');
      assert.equal(report.idle.writes, 0, 'unchanged polls do not rewrite preferences');
      assert.equal(report.selectionTabRebuilds, 0, 'model changes do not rebuild tab/menu DOM');
      assert.equal(report.previewAttributeWrites, 0, 'summary updates do not rewrite preview attributes');
    }
  }
  if (process.env.ARCANE_PERF_REPORT) await writeFile(process.env.ARCANE_PERF_REPORT, JSON.stringify({ fixture: true, browser: await browser.version(), reports }, null, 2));
  console.log(JSON.stringify({ fixture: true, browser: await browser.version(), reports }));
});
