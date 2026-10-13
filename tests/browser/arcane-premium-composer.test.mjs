import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';

// Frozen file documents only: no product JS, native bridge, daemon, account or transport.
// The supplied summary/list contract is mounted only when the current HTML is legacy.
// These are CSS state checks, not evidence of controller behavior or provider readiness.
test('premium composer fits its frozen contract and signed-out gate', async t => {
  const [html, css] = await Promise.all([
    readFile(resolve('apps/desktop/public/studio.html'), 'utf8'),
    readFile(resolve('apps/desktop/public/studio.css'), 'utf8'),
  ]);
  const output = process.env.ARCANE_COMPOSER_PROOF_DIR
    ? resolve(process.env.ARCANE_COMPOSER_PROOF_DIR)
    : await mkdtemp(join(tmpdir(), 'arcane-premium-composer-'));
  await mkdir(output, { recursive: true });
  const frozen = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<link\b[^>]*href="\/studio\.css"[^>]*>/, `<style>${css}</style>`);
  const signedOutPath = join(output, 'signed-out.html');
  await writeFile(signedOutPath, frozen);
  const browser = await chromium.launch({ headless: true,
    ...(process.env.ARCANE_COMPOSER_BROWSER
      ? { executablePath: process.env.ARCANE_COMPOSER_BROWSER }
      : process.platform === 'win32' ? { channel: 'msedge' } : {}),
  });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const network = [];
  await page.route(/^https?:/, route => { network.push(route.request().url()); return route.abort(); });
  await page.goto(pathToFileURL(signedOutPath).href);
  assert.equal(await page.locator('script').count(), 0);
  assert.equal(await page.locator('#provider-login-gate').isVisible(), true);
  for (const selector of ['#codex-compose', '#new-chat', '.sidebar-links', '.sidebar-secondary',
    '#workspace-topbar', '.chat-topline', '#workflow-details', '#codex-messages']) {
    assert.equal(await page.locator(selector).isVisible(), false, `signed-out ${selector}`);
  }
  await page.screenshot({ path: join(output, 'signed-out-desktop.png') });

  // Mount document states directly, with no fabricated provider/account objects.
  const mountedContract = await page.evaluate(() => {
    document.getElementById('workspace-stage').classList.remove('provider-required');
    document.getElementById('provider-login-gate').hidden = true;
    document.querySelector('.workspace-welcome').hidden = true;
    document.getElementById('codex-notice').textContent = '';
    const plus = document.getElementById('workspace-add-context');
    plus.setAttribute('aria-label', 'Attach text file');
    plus.setAttribute('title', 'Attach text file');
    plus.innerHTML = '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';
    const controls = document.querySelector('.composer-controls');
    controls.dataset.taskActive = 'false';
    const context = document.querySelector('.composer-tool-context');
    if (context) context.lastElementChild.textContent = 'Task';
    const popover = document.getElementById('codex-model-popover');
    const missing = !document.getElementById('codex-picker-summary');
    if (missing) {
      const search = document.getElementById('codex-model-search');
      const options = document.getElementById('codex-model-options');
      const empty = document.getElementById('codex-model-empty');
      const apply = document.getElementById('codex-picker-apply');
      const fallback = document.querySelector('.picker-effort-section');
      popover.replaceChildren();
      const summary = document.createElement('div');
      summary.id = 'codex-picker-summary';
      summary.innerHTML = '<h2>Reasoning<span id="codex-picker-effort-value">Medium</span></h2>' +
        '<button type="button" id="codex-picker-current-model"><span>Choose model</span><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="m9 5 7 7-7 7"/></svg></button>' +
        '<label class="native-effort" for="codex-picker-effort-slider"><span class="visually-hidden">Reasoning effort</span><input id="codex-picker-effort-slider" type="range" min="0" max="3" value="1" aria-valuetext="Medium"></label>' +
        '<button type="button" id="codex-picker-reset">Reset to default</button>';
      const list = document.createElement('div');
      list.id = 'codex-picker-model-list'; list.hidden = true;
      list.innerHTML = '<button id="codex-picker-back" type="button">Back</button>';
      list.append(search, options, empty);
      if (fallback) { fallback.hidden = true; popover.append(fallback); }
      popover.prepend(summary, list);
      popover.append(apply);
    }
    return missing;
  });
  const composerPath = join(output, 'composer-contract.html');
  await writeFile(composerPath, await page.content());
  await page.goto(pathToFileURL(composerPath).href);

  const geometry = async selector => page.locator(selector).evaluate(el => {
    const r = el.getBoundingClientRect(), s = getComputedStyle(el);
    return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right,
      bottom: r.bottom, radius: s.borderRadius, color: s.color, background: s.backgroundColor };
  });
  const assertFits = async () => {
    const [input, plus, chip, send, composer] = await Promise.all([
      geometry('#codex-composer'), geometry('#workspace-add-context'),
      geometry('#codex-model-trigger'), geometry('#codex-submit'), geometry('#codex-compose'),
    ]);
    assert.ok(input.bottom <= plus.y, 'textarea above control row');
    assert.ok(plus.right <= chip.x, 'attachment left of chip');
    assert.ok(chip.right <= send.x, 'chip left of send');
    assert.ok(Math.abs(plus.y - send.y) <= 1, 'single control row');
    assert.ok(Math.abs(chip.y + chip.height / 2 - send.y - send.height / 2) <= 1);
    assert.equal(send.width, send.height); assert.equal(send.radius, '50%');
    assert.ok(send.right <= composer.right, 'send fits composer');
    assert.ok(composer.right <= await page.evaluate(() => innerWidth));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  };
  await assertFits();
  await page.screenshot({ path: join(output, 'composer-desktop.png') });

  await page.evaluate(() => {
    const popover = document.getElementById('codex-model-popover');
    const trigger = document.getElementById('codex-model-trigger').getBoundingClientRect();
    popover.hidden = false;
    popover.style.right = `${innerWidth - trigger.right}px`;
    popover.style.bottom = `${innerHeight - trigger.top + 8}px`;
  });
  assert.equal((await geometry('#codex-model-popover')).width, 240);
  assert.equal(await page.locator('#codex-picker-effort-slider').isVisible(), true);
  assert.equal(await page.locator('#codex-picker-efforts').isVisible(), false);
  await page.locator('#codex-picker-current-model').focus();
  assert.equal(await page.locator('#codex-picker-current-model').evaluate(el => getComputedStyle(el).outlineStyle), 'solid');
  await page.screenshot({ path: join(output, 'reasoning-desktop.png') });
  await page.evaluate(() => {
    document.getElementById('codex-picker-summary').hidden = true;
    document.getElementById('codex-picker-model-list').hidden = false;
  });
  assert.equal((await geometry('#codex-model-popover')).width, 300);
  assert.equal(await page.locator('#codex-model-search').isVisible(), true);
  assert.equal(await page.locator('#codex-picker-back').isVisible(), true);
  assert.equal(await page.locator('#codex-picker-summary').isVisible(), false);
  assert.equal(await page.locator('#codex-picker-apply').isDisabled(), true, 'guarded apply preserved');
  await page.screenshot({ path: join(output, 'model-list-desktop.png') });

  await page.evaluate(() => {
    document.getElementById('codex-model-popover').hidden = true;
    document.querySelector('.composer-controls').dataset.taskActive = 'true';
    document.querySelector('.composer-tool-context').hidden = false;
    document.getElementById('codex-submit').disabled = false;
    document.getElementById('codex-submit').setAttribute('aria-label', 'Stop task');
    document.getElementById('codex-submit').innerHTML = '<svg class="icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="1"/></svg>';
    document.getElementById('codex-model-label').textContent = 'Long model label for layout proof';
    document.getElementById('codex-effort-label').textContent = 'Extra high';
    document.getElementById('codex-effort-label').hidden = false;
  });
  for (const width of [760, 390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await assertFits();
    assert.equal(await page.locator('.composer-tool-context').isVisible(), true);
  }
  await page.screenshot({ path: join(output, 'composer-active-mobile.png') });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await page.evaluate(() => [...document.querySelectorAll('*')].some(el => {
    const s = getComputedStyle(el); return s.animationName !== 'none' || s.transitionDuration !== '0s';
  })), false, 'reduced motion and no idle animation');
  assert.deepEqual(network, [], 'no external requests');
  console.log(`Frozen CSS proof: ${output}; supplied-contract fixture: ${mountedContract}`);
});
