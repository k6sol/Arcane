import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFile, writeFile, mkdir, mkdtemp } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright-core';

// Opt-in, like the other private-emit browser tests:
// ARCANE_PLAYTEST_PANEL_EMIT=runtime/verification/playtest-private-20261014/dist
// node --test tests/browser/playtest-panel.test.mjs
// ARCANE_PLAYTEST_PANEL_BROWSER optionally selects an Edge/Chromium executable.
// Windows AppContainer loopback requires running this command with require_escalated.
// Only an owned ephemeral localhost server and a fresh headless browser are used.
// All API jobs (including evidence:'native') are synthetic UI fixtures, never Studio evidence.
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const emitPath = process.env.ARCANE_PLAYTEST_PANEL_EMIT;
const TOKEN = 'synthetic-browser-fixture-token';
const ACTOR = 'synthetic-actor-never-display';
const NAME = 'Synthetic fixture · Cube.Root → timeArrow';
const XSS = '<img src="/unexpected-xss" onerror="window.__fixtureXss=true"><script>window.__fixtureXss=true</script>';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

// StudioTestView / TestReview from studio-test-service and the controller, with
// the explicit UI name and optional private-target text used by the unit helper.
// This is an in-memory HTTP response fake, not a native controller or acceptance run.
function controllerMemoryFake(id, pluginSourceHash, digest, {
  state = 'needs_approval', evidence = 'fixture', targetName = NAME,
} = {}) {
  const display = {
    proposal: {
      binding: { pairedSessionId: 'synthetic-paired-session', nativeStudioId: 'synthetic-studio-id', placeId: 0,
        clientLifetimeId: 'synthetic-plugin-lifetime', pluginArtifactHash: pluginSourceHash,
        scopeRevision: sha256('synthetic-scope-revision') },
      durationMs: 5000, observationIntervalMs: 1000, failOnRuntimeError: true,
      trustedPrivateTarget: { name: targetName, source: 'Synthetic UI fixture only: ' + XSS },
    },
    cleanupGraceMs: 5000, requestTimeoutMs: 10000, proofMaxAgeMs: 6000,
    consentExpiresAt: Date.now() + 60_000, guarantee: 'observed-non-atomic',
    actions: ['start', 'observe-state-and-console', 'stop-owned-play'],
    raceDisclosure: 'Observed checks cannot atomically fence the native call.',
  };
  return {
    id, targetName, actor: ACTOR, state, display, displayDigest: digest(display), evidence, nativeAcceptance: false,
    review: {
      runId: state === 'running' ? id : null, evidence, nativeAcceptance: false,
      binding: state === 'running' ? display.proposal.binding : null,
      scopeDigest: state === 'running' ? digest(display) : null,
      phase: state === 'running' ? 'waiting' : 'idle', outcome: null, code: 'OK',
      cleanup: state === 'running' ? 'running' : 'not_started',
      startedAt: null, deadline: null, cleanupDeadline: null,
      watchdog: { armed: state === 'running', fired: false, reason: null },
      observations: 0, logs: [], logsTruncated: false, requiresHumanReview: false, canStartAnotherOperation: false,
    },
  };
}

function displayFields(job) {
  const fields = [];
  function walk(value, path) {
    if (Array.isArray(value)) value.forEach((child, index) => walk(child, `${path}[${index}]`));
    else if (value && typeof value === 'object') Object.entries(value).forEach(([key, child]) => walk(child, `${path}.${key}`));
    else fields.push([path, String(value)]);
  }
  walk(job.display, 'display'); fields.push(['displayDigest', job.displayDigest]); return fields;
}

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Synthetic playtest panel browser fixture</title>
<link rel="icon" href="/favicon.ico"><link rel="stylesheet" href="/studio.css">
<link rel="stylesheet" href="/fixture.css"><script type="module" src="/fixture.mjs"></script></head>
<body class="arcane-app"><div id="fixture-context"><h2>Synthetic browser UI fixture</h2>
<p>Fake localhost API · No native Studio acceptance · Cube.Root → timeArrow</p>
<button id="fixture-login" type="button">Sign in to synthetic fixture</button></div>
<section id="playtest-panel" class="playtest-panel" hidden></section></body></html>`;
// Host layout only. The panel's sizing, wrapping, details and controls use studio.css unchanged.
const fixtureCss = `body.arcane-app{height:auto;min-height:100vh;overflow:visible}
#fixture-context{width:100%;max-width:720px;margin:18px auto 0;padding:0 18px}
#fixture-context h2{font-size:16px}#fixture-context p{font-size:12px;overflow-wrap:anywhere}`;
const bootstrap = `import { startPlaytestPanel } from '/playtest-panel.js';
let signedIn = false;
const clicks = [], violations = [];
document.addEventListener('click', event => {
  const control = event.target.closest?.('[data-playtest-action],#fixture-login');
  if (control) clicks.push({ action: control.dataset.playtestAction ?? 'fixture-login',
    trusted: event.isTrusted, heading: control.closest('article')?.querySelector('h3')?.textContent ?? null });
}, true);
document.addEventListener('securitypolicyviolation', event => violations.push({
  directive: event.effectiveDirective, blockedURI: event.blockedURI, disposition: event.disposition }));
const panel = startPlaytestPanel({ root: document.getElementById('playtest-panel'),
  token: () => '${TOKEN}', isSignedIn: () => signedIn });
window.__playtestFixture = { panel, clicks, violations };
document.getElementById('fixture-login').addEventListener('click', async () => {
  signedIn = true; await panel.refresh();
});`;

async function serve(t, assets, report) {
  let jobs = [], ambiguous = null;
  const api = [], unexpected = [];
  const files = new Map([
    ['/', ['text/html; charset=utf-8', html]], ['/studio.css', ['text/css; charset=utf-8', assets.css]],
    ['/fixture.css', ['text/css; charset=utf-8', fixtureCss]], ['/fixture.mjs', ['text/javascript; charset=utf-8', bootstrap]],
    ['/playtest-panel.js', ['text/javascript; charset=utf-8', assets.panel]],
  ]);
  const server = createServer((request, response) => {
    void (async () => {
      response.setHeader('Content-Security-Policy', assets.policy);
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('X-Content-Type-Options', 'nosniff');
      const send = (status, value) => {
        response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(value));
      };
      const path = request.url, method = request.method;
      if (method === 'GET' && path === '/favicon.ico') { response.writeHead(204); response.end(); return; }
      if (method === 'GET' && files.has(path)) {
        const [type, body] = files.get(path); response.writeHead(200, { 'Content-Type': type }); response.end(body); return;
      }
      if (!((method === 'GET' && path === '/v1/playtests') ||
          (method === 'POST' && ['/v1/playtests/approve', '/v1/playtests/cancel'].includes(path)))) {
        unexpected.push({ method, path }); send(404, { error: 'SYNTHETIC_FIXTURE_ROUTE_ONLY' }); return;
      }
      const chunks = []; let bytes = 0;
      for await (const chunk of request) { bytes += chunk.length; assert.ok(bytes <= 4096); chunks.push(chunk); }
      const rawBody = Buffer.concat(chunks).toString('utf8');
      const body = rawBody ? JSON.parse(rawBody) : null;
      const call = { method, path, rawBody, body, headers: {
        authorization: request.headers.authorization, accept: request.headers.accept,
        contentType: request.headers['content-type'] ?? null, origin: request.headers.origin ?? null,
      } };
      api.push(call);
      assert.equal(call.headers.authorization, 'Bearer ' + TOKEN);
      assert.equal(call.headers.accept, 'application/json');
      if (method === 'GET') { assert.equal(rawBody, ''); send(200, { jobs }); return; }
      assert.equal(call.headers.contentType, 'application/json');
      const current = jobs.find(job => job.id === body.id); assert.ok(current, 'POST must name an existing fixture job');
      assert.equal(current.nativeAcceptance, false);
      assert.deepEqual(body, path.endsWith('/approve') ? { id: current.id, displayDigest: current.displayDigest } : { id: current.id });
      // Simulate an ambiguous HTTP acknowledgement: status reads still show pending.
      if (ambiguous?.id === current.id && ambiguous.path === path) {
        send(503, { error: 'SYNTHETIC_AMBIGUOUS_ACK', privateDetail: ACTOR + ' ' + TOKEN + ' ' + XSS }); return;
      }
      current.state = path.endsWith('/approve') ? 'running' : 'cancelled';
      current.review = { ...current.review, runId: current.state === 'running' ? current.id : null,
        phase: current.state === 'running' ? 'waiting' : 'done', outcome: current.state === 'running' ? null : 'cancelled',
        cleanup: current.state === 'running' ? 'running' : 'not_started' };
      send(200, { job: current });
    })().catch(error => {
      report.serverErrors.push(error.stack ?? String(error));
      if (!response.headersSent) response.writeHead(500, { 'Content-Type': 'application/json' });
      response.end('{}');
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise((done, reject) => server.close(error => error ? reject(error) : done())); });
  report.api = api; report.unexpectedLocalRequests = unexpected;
  return {
    origin: `http://127.0.0.1:${server.address().port}`, api,
    jobs(value) { jobs = structuredClone(value); },
    ambiguous(id, path) { ambiguous = { id, path }; },
    posts() { return api.filter(call => call.method === 'POST'); },
  };
}

async function idle(page) {
  await page.waitForFunction(() => document.getElementById('playtest-panel').getAttribute('aria-busy') === 'false');
}
async function refresh(page) { await page.evaluate(() => window.__playtestFixture.panel.refresh()); await idle(page); }
function row(page, name) { return page.locator('.playtest-row').filter({ has: page.getByRole('heading', { name: 'Playtest · ' + name, exact: true }) }); }
async function mouseClick(page, control) {
  await control.waitFor({ state: 'visible' });
  assert.equal(await control.isEnabled(), true);
  await control.scrollIntoViewIfNeeded();
  const bounds = await control.boundingBox(); assert.ok(bounds);
  await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
}
async function assertFields(actualRow, expected) {
  assert.equal(await actualRow.locator('details').evaluate(element => element.open), true);
  assert.deepEqual(await actualRow.locator('dl').evaluate(element => [...element.querySelectorAll('dt')]
    .map(dt => [dt.textContent, dt.nextElementSibling.textContent])), displayFields(expected));
}
async function assertFits(page, width) {
  const geometry = await page.evaluate(() => {
    const panel = document.getElementById('playtest-panel');
    const visible = [panel, ...panel.querySelectorAll('*')].filter(element => element.getClientRects().length);
    return { viewport: innerWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth,
      panel: panel.getBoundingClientRect().width, maxWidth: getComputedStyle(panel).maxWidth,
      columns: getComputedStyle(panel.querySelector('dl')).gridTemplateColumns,
      // Existing 130px desktop label tracks let long paths overlap values. Record
      // that real CSS limitation; the requested strict no-overflow gate is mobile.
      overflowingLabels: [...panel.querySelectorAll('dt')].filter(element => element.scrollWidth > element.clientWidth + 1)
        .map(element => element.textContent),
      overflow: visible.filter(element => {
        const rect = element.getBoundingClientRect();
        return rect.left < -1 || rect.right > innerWidth + 1 || (innerWidth === 360 && element.scrollWidth > element.clientWidth + 1);
      }).map(element => ({ tag: element.tagName, text: element.textContent.slice(0,100) })) };
  });
  assert.equal(geometry.viewport, width);
  assert.ok(geometry.document <= width && geometry.body <= width, JSON.stringify(geometry));
  assert.deepEqual(geometry.overflow, []);
  assert.equal(geometry.maxWidth, '720px');
  if (width > 720) assert.equal(geometry.panel, 720);
  if (width === 360) assert.equal(geometry.columns.split(' ').length, 1);
  return geometry;
}

test('real Edge/Chromium playtest panel render, consent HTTP and CSP (synthetic fixtures only)', {
  skip: !emitPath, timeout: 90_000,
}, async t => {
  const emit = resolve(repository, emitPath), verification = join(repository, 'runtime/verification');
  const privatePath = relative(verification, emit);
  assert.ok(!isAbsolute(privatePath) && privatePath !== '..' && !privatePath.startsWith('..\\') && !privatePath.startsWith('../'),
    'Select a private verification emit, never the root dist');
  const [panel, css, serverSource, pluginSource, pluginManifest] = await Promise.all([
    readFile(join(emit, 'apps/desktop/src/playtest-panel.js'), 'utf8'), readFile(join(repository, 'apps/desktop/public/studio.css'), 'utf8'),
    readFile(join(repository, 'apps/daemon/src/lab-server.ts'), 'utf8'), readFile(join(repository, 'plugin/build/ArcaneLocalBridge.lua')),
    readFile(join(repository, 'plugin/build/manifest.json'), 'utf8'),
  ]);
  const policy = /setHeader\('Content-Security-Policy', "([^"]+)"\)/.exec(serverSource)?.[1]; assert.ok(policy);
  for (const rule of ["script-src 'self';", "style-src 'self';", "connect-src 'self' blob:;", "object-src 'none';"]) assert.ok(policy.includes(rule));
  assert.doesNotMatch(policy, /unsafe-inline|unsafe-eval/);
  const pluginSourceHash = sha256(pluginSource);
  assert.equal(JSON.parse(pluginManifest).artifacts.find(artifact => artifact.name === 'ArcaneLocalBridge.lua')?.sha256, pluginSourceHash);
  // Digest is the actual controller's canonical digest; Node-only code is never served to the browser.
  const { digest } = await import(pathToFileURL(join(emit, 'packages/studio-test-controller/src/contracts.js')).href);
  await mkdir(verification, { recursive: true });
  const proofDir = await mkdtemp(join(verification, 'playtest-browser-'));
  const report = { evidence: 'Synthetic browser UI fixtures only; no genuine native Studio acceptance', nativeAcceptance: false,
    emit, productionCsp: policy, sourceHashes: { panel: sha256(panel), studioCss: sha256(css), pluginSourceHash,
      test: sha256(await readFile(fileURLToPath(import.meta.url))) }, checks: [], screenshots: [], console: [],
    serverErrors: [], pageErrors: [], forbiddenNetwork: [] };
  // Retain evidence even on failure, and stop only resources created by this test.
  t.after(async () => {
    await writeFile(join(proofDir, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    console.log('Synthetic browser UI evidence: ' + proofDir);
  });
  const f = await serve(t, { panel, css, policy }, report);
  const browser = await chromium.launch({ headless: true,
    ...(process.env.ARCANE_PLAYTEST_PANEL_BROWSER ? { executablePath: process.env.ARCANE_PLAYTEST_PANEL_BROWSER }
      : process.platform === 'win32' ? { channel: 'msedge' } : {}),
    args: ['--disable-background-networking'],
  }); t.after(() => browser.close()); report.browser = await browser.version();
  const context = await browser.newContext({ viewport: { width: 1120, height: 900 }, deviceScaleFactor: 1, serviceWorkers: 'block' });
  t.after(() => context.close());
  await context.route('**/*', route => {
    if (new URL(route.request().url()).origin === f.origin) return route.continue();
    report.forbiddenNetwork.push(route.request().url()); return route.abort();
  });
  const page = await context.newPage(); page.setDefaultTimeout(8000);
  page.on('pageerror', error => report.pageErrors.push(error.message));
  page.on('console', message => report.console.push({ type: message.type(), text: message.text() }));
  const capture = async name => {
    const path = join(proofDir, name + '.png');
    const png = await page.screenshot({ path, fullPage: true, scale: 'css' });
    assert.equal(png.readUInt32BE(16), page.viewportSize().width);
    assert.ok(png.readUInt32BE(20) >= page.viewportSize().height);
    report.screenshots.push({ file: name + '.png', width: png.readUInt32BE(16), height: png.readUInt32BE(20), sha256: sha256(png) });
  };
  try {
    const pending = controllerMemoryFake('synthetic-pending', pluginSourceHash, digest);
    f.jobs([pending]);
    const documentResponse = await page.goto(f.origin); assert.equal(documentResponse.headers()['content-security-policy'], policy);
    await page.waitForFunction(() => !!window.__playtestFixture);
    assert.equal(await page.locator('#playtest-panel').isVisible(), false);
    assert.equal(await page.getByRole('region', { name: 'Playtests', exact: true }).count(), 0);
    assert.equal(await page.locator('#playtest-panel').evaluate(element => element.hidden && element.childElementCount === 0), true);
    await refresh(page); await delay(2250); assert.deepEqual(f.api, []);
    report.checks.push('unsigned: hidden empty panel and zero API requests across a real poll interval');
    await capture('unsigned-synthetic-ui');

    // Actively prove the browser enforces the served policy, not just its spelling.
    await page.evaluate(() => {
      window.__cspProbe = false;
      const script = document.createElement('script'); script.textContent = 'window.__cspProbe=true'; document.body.append(script); script.remove();
      const style = document.createElement('style'); style.textContent = '#fixture-context{display:none!important}'; document.head.append(style); style.remove();
    });
    await page.waitForFunction(() => window.__playtestFixture.violations.length === 2);
    assert.equal(await page.evaluate(() => window.__cspProbe), false);
    const violations = await page.evaluate(() => window.__playtestFixture.violations);
    assert.deepEqual(violations.map(value => value.directive).sort(), ['script-src-elem', 'style-src-elem']);
    assert.ok(violations.every(value => value.blockedURI === 'inline' && value.disposition === 'enforce'));
    report.cspViolations = violations; report.checks.push('production CSP blocks actual inline script and style probes');

    await mouseClick(page, page.locator('#fixture-login'));
    await page.getByRole('button', { name: 'Run test · ' + NAME, exact: true }).waitFor(); await idle(page);
    const pendingRow = row(page, NAME);
    const region = page.getByRole('region', { name: 'Playtests', exact: true });
    assert.equal(await region.count(), 1); assert.equal(await region.getAttribute('aria-busy'), 'false');
    for (const label of ['Run test', 'Cancel']) {
      const control = region.getByRole('button', { name: label + ' · ' + NAME, exact: true });
      assert.equal(await control.count(), 1); assert.equal(await control.getAttribute('type'), 'button');
    }
    assert.equal(await pendingRow.locator('h3').textContent(), 'Playtest · ' + NAME);
    assert.equal(await pendingRow.locator('.playtest-subtitle').textContent(), '5 s · Local, unpublished place');
    assert.equal(await pendingRow.locator('.playtest-evidence').textContent(), 'Fixture evidence · Native acceptance unverified');
    assert.equal(await pendingRow.locator('details').evaluate(element => element.open), false);
    await mouseClick(page, pendingRow.locator('summary')); await assertFields(pendingRow, pending);
    await pendingRow.locator('summary').focus(); await page.keyboard.press('Enter');
    assert.equal(await pendingRow.locator('details').evaluate(element => element.open), false);
    await page.keyboard.press('Enter'); await assertFields(pendingRow, pending);
    assert.equal(await pendingRow.locator('summary').evaluate(element => document.activeElement === element &&
      getComputedStyle(element).outlineStyle === 'solid'), true);
    assert.deepEqual(f.posts(), []);
    report.checks.push('bounded a11y checks: named region/buttons, real keyboard details toggle and visible focus; no full-app audit');
    assert.equal(await page.locator('#playtest-panel img,#playtest-panel script').count(), 0);
    assert.equal(await page.evaluate(() => window.__fixtureXss), undefined);
    assert.equal(await pendingRow.locator('dd').filter({ hasText: XSS }).count(), 1);
    assert.doesNotMatch(await page.locator('#playtest-panel').textContent(), new RegExp(ACTOR + '|' + TOKEN));
    const cssResponse = await page.request.get(f.origin + '/studio.css'); assert.equal(await cssResponse.text(), css);
    report.desktopGeometry = await assertFits(page, 1120);
    report.checks.push('exact consent fields/digest/plugin source hash, explicit fixture name and literal XSS text under real CSS');
    await capture('pending-expanded-720px-synthetic-ui');
    await page.setViewportSize({ width: 360, height: 800 });
    report.mobileGeometry = await assertFits(page, 360); await assertFields(pendingRow, pending);
    await capture('pending-expanded-360px-synthetic-ui');
    await page.setViewportSize({ width: 1120, height: 900 });

    // DOM .click() is intentionally untrusted; only actual mouse input authorizes.
    const run = pendingRow.locator('[data-playtest-action="approve"]');
    await run.evaluate(button => { button.click(); button.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await refresh(page); assert.deepEqual(f.posts(), []);
    await mouseClick(page, run); await pendingRow.getByRole('button', { name: 'Stop · ' + NAME, exact: true }).waitFor(); await idle(page);
    assert.equal(f.posts().length, 1);
    assert.deepEqual(f.posts()[0].body, { id: pending.id, displayDigest: pending.displayDigest });
    assert.equal(f.posts()[0].rawBody, JSON.stringify({ id: pending.id, displayDigest: pending.displayDigest }));
    assert.equal(f.posts()[0].path, '/v1/playtests/approve'); assert.equal(f.posts()[0].headers.origin, f.origin);
    assert.equal(await pendingRow.locator('.playtest-status').textContent(), 'Testing…');
    await assertFields(pendingRow, pending); await refresh(page); assert.equal(f.posts().length, 1);
    report.checks.push('trusted mouse Run test sends exact approval POST once; programmatic clicks send none');

    const cancelJob = controllerMemoryFake('synthetic-existing-cancel', pluginSourceHash, digest, { targetName: 'Synthetic existing request' });
    f.jobs([cancelJob]); await refresh(page);
    const cancelRow = row(page, cancelJob.targetName), cancel = cancelRow.locator('[data-playtest-action="cancel"]');
    assert.equal(await cancel.textContent(), 'Cancel'); await cancel.evaluate(button => button.click()); assert.equal(f.posts().length, 1);
    await mouseClick(page, cancel); await page.getByText('Test cancelled', { exact: true }).waitFor(); await idle(page);
    assert.equal(f.posts().length, 2); assert.equal(f.posts()[1].path, '/v1/playtests/cancel');
    assert.equal(f.posts()[1].rawBody, JSON.stringify({ id: cancelJob.id })); assert.deepEqual(f.posts()[1].body, { id: cancelJob.id });
    assert.equal(f.posts()[1].headers.origin, f.origin); await refresh(page); assert.equal(f.posts().length, 2);
    report.checks.push('trusted mouse Cancel sends only the existing ID to cancel once');

    const stopJob = controllerMemoryFake('synthetic-existing-run', pluginSourceHash, digest, { state: 'running', targetName: 'Synthetic existing running test' });
    f.jobs([stopJob]); await refresh(page);
    await mouseClick(page, row(page, stopJob.targetName).getByRole('button', { name: 'Stop · ' + stopJob.targetName, exact: true }));
    await page.getByText('Test cancelled', { exact: true }).waitFor(); await idle(page);
    assert.equal(f.posts().length, 3); assert.equal(f.posts()[2].path, '/v1/playtests/cancel');
    assert.equal(f.posts()[2].rawBody, JSON.stringify({ id: stopJob.id })); assert.deepEqual(f.posts()[2].body, { id: stopJob.id });
    assert.equal(f.posts()[2].headers.origin, f.origin); await refresh(page); assert.equal(f.posts().length, 3);
    report.checks.push('trusted mouse Stop cancels the exact existing running job once');

    const ambiguous = controllerMemoryFake('synthetic-ambiguous', pluginSourceHash, digest, { targetName: 'Synthetic ambiguous HTTP request' });
    f.jobs([ambiguous]); f.ambiguous(ambiguous.id, '/v1/playtests/approve'); await refresh(page);
    const ambiguousRow = row(page, ambiguous.targetName);
    await mouseClick(page, ambiguousRow.locator('[data-playtest-action="approve"]'));
    await page.getByText('Couldn’t confirm the request. Refresh status; this request won’t be sent again.', { exact: true }).waitFor(); await idle(page);
    const postCount = f.posts().length; assert.equal(postCount, 4);
    assert.equal(await ambiguousRow.locator('[data-playtest-action="approve"]').isDisabled(), true);
    await mouseClick(page, page.getByRole('button', { name: 'Refresh status', exact: true })); await idle(page);
    const reads = f.api.filter(call => call.method === 'GET').length;
    await page.waitForFunction(() => document.getElementById('playtest-panel').getAttribute('aria-busy') === 'false');
    // Cross at least one real automatic poll, with bounded wall time.
    const deadline = Date.now() + 4000;
    while (f.api.filter(call => call.method === 'GET').length === reads) { assert.ok(Date.now() < deadline, 'expected a status-only automatic poll'); await delay(50); }
    await idle(page); await refresh(page);
    await ambiguousRow.locator('[data-playtest-action="approve"]').evaluate(button => button.click());
    assert.equal(f.posts().length, postCount); assert.equal(await ambiguousRow.locator('[data-playtest-action="approve"]').isDisabled(), true);
    assert.doesNotMatch(await page.locator('#playtest-panel').textContent(), /SYNTHETIC_AMBIGUOUS_ACK|synthetic-actor-never-display|synthetic-browser-fixture-token/);
    report.checks.push('HTTP 503 stays ambiguous; manual refresh and automatic polling never retake consent or retry POST');
    await capture('ambiguous-no-retry-synthetic-ui');

    const runningNative = controllerMemoryFake('synthetic-native-label', pluginSourceHash, digest, { state: 'running', evidence: 'native', targetName: 'Synthetic native-tagged response' });
    const runningFixture = controllerMemoryFake('synthetic-fixture-label', pluginSourceHash, digest, { state: 'running', targetName: 'Synthetic fixture-tagged response' });
    f.jobs([runningNative, runningFixture]); await refresh(page);
    for (const job of [runningNative, runningFixture]) {
      const actual = row(page, job.targetName); assert.equal(await actual.locator('.playtest-status').textContent(), 'Testing…');
      assert.equal(await actual.locator('[data-playtest-action="cancel"]').textContent(), 'Stop');
    }
    assert.equal(await row(page, runningNative.targetName).locator('.playtest-evidence').count(), 0, 'active native-tagged UI has no fixture label');
    assert.equal(await row(page, runningFixture.targetName).locator('.playtest-evidence').textContent(), 'Fixture evidence · Native acceptance unverified');
    await capture('running-native-vs-fixture-labels-synthetic-ui');
    runningNative.state = 'complete'; runningNative.review = { ...runningNative.review, phase: 'done', outcome: 'succeeded', code: 'OK', cleanup: 'complete' };
    runningFixture.state = 'complete'; runningFixture.review = { ...runningFixture.review, phase: 'done', outcome: 'failed', code: 'EFFECT_UNKNOWN', cleanup: 'unknown', requiresHumanReview: true };
    f.jobs([runningNative, runningFixture]); await refresh(page);
    assert.equal(await row(page, runningNative.targetName).locator('.playtest-evidence').textContent(), 'Native evidence · Native acceptance unverified');
    assert.equal(await row(page, runningNative.targetName).locator('.playtest-status').textContent(), 'Test finished');
    assert.equal(await row(page, runningFixture.targetName).locator('.playtest-status').textContent(), 'Needs review');
    assert.equal(await row(page, runningFixture.targetName).locator('.playtest-status').evaluate(element => element.classList.contains('danger')), true);
    assert.equal(await row(page, runningFixture.targetName).locator('button').count(), 0);
    assert.equal(f.posts().length, postCount);
    report.checks.push('running native/fixture labels, neutral native completion and unknown cleanup Needs review');
    await capture('unknown-cleanup-needs-review-synthetic-ui');
    report.clicks = await page.evaluate(() => window.__playtestFixture.clicks);
    assert.deepEqual(report.clicks.filter(click => click.trusted && click.action === 'approve').map(click => click.heading), ['Playtest · ' + NAME, 'Playtest · ' + ambiguous.targetName]);
    assert.deepEqual(report.clicks.filter(click => click.trusted && click.action === 'cancel').map(click => click.heading),
      ['Playtest · ' + cancelJob.targetName, 'Playtest · ' + stopJob.targetName]);
    assert.deepEqual(report.pageErrors, []); assert.deepEqual(report.serverErrors, []);
    assert.deepEqual(report.unexpectedLocalRequests, []); assert.deepEqual(report.forbiddenNetwork, []);
    assert.equal(await page.evaluate(() => window.__playtestFixture.violations.length), 2);
    report.result = 'passed';
  } catch (error) {
    report.result = 'failed'; report.failure = error.stack ?? String(error);
    await capture('failure-synthetic-ui').catch(() => {}); throw error;
  } finally {
    await page.evaluate(() => window.__playtestFixture?.panel.stop()).catch(() => {});
  }
});
