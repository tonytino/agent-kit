import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { capture, launchChromium, slugify } from '../src/capture.mjs';

const page = (label) => `<!doctype html><html><body>
<h1>${label}</h1>
<input id="q"><button onclick="document.body.insertAdjacentHTML('beforeend', '<p>Results for ' + document.getElementById('q').value + '</p>')">Search</button>
<div style="height:2000px"></div></body></html>`;

/** @param {string} label */
function serve(label, seen) {
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url, token: req.headers['x-test-token'] });
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(page(label));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

const tmp = await mkdtemp(path.join(os.tmpdir(), 'pr-visuals-capture-test-'));
after(() => rm(tmp, { recursive: true, force: true }));

test('slugify makes unique directory names', () => {
  const used = new Set();
  assert.equal(slugify('Directory filters!', used), 'directory-filters');
  assert.equal(slugify('Directory  filters', used), 'directory-filters-2');
  assert.equal(slugify('***', used), 'scenario');
});

test('captures before and after screenshots and videos with Chromium', async (t) => {
  try {
    const browser = await launchChromium();
    await browser.close();
  } catch (err) {
    t.skip(`Chromium cannot launch: ${String(err).split('\n')[0]}`);
    return;
  }
  const beforeSeen = [];
  const afterSeen = [];
  const before = await serve('Before', beforeSeen);
  const afterSrv = await serve('After', afterSeen);
  try {
    const out = path.join(tmp, 'out');
    const { manifest, total, failed } = await capture({
      beforeUrl: `http://127.0.0.1:${before.address().port}`,
      afterUrl: `http://127.0.0.1:${afterSrv.address().port}`,
      scenarios: [
        {
          name: 'Search', path: '/?q=1', viewports: ['desktop'], video: true,
          steps: [{ fill: ['#q', 'pizza'] }, { click: 'role=button[name="Search"]' }, { waitFor: 'text=Results for pizza' },
            { scroll: 300 }, { press: 'Tab' }, { hover: 'h1' }, { wait: 50 }, { goto: '/next' }],
        },
        { name: 'Broken', path: '/', viewports: ['desktop'], video: false, steps: [{ click: '#missing' }] },
      ],
      viewports: { desktop: { width: 800, height: 600 } },
      outDir: out,
      headers: { 'x-test-token': 'tok' },
    });
    // Counts cover after-side cells only.
    assert.equal(total, 2);
    assert.equal(failed, 1);
    const cell = manifest.scenarios[0].cells[0];
    for (const f of [cell.before.screenshot, cell.after.screenshot, cell.before.video, cell.after.video]) {
      assert.ok(f, 'file recorded in manifest');
      assert.ok((await stat(path.join(out, f))).size > 0, f);
    }
    assert.equal(cell.before.screenshot, 'search/desktop-before.png');
    assert.equal(cell.after.video, 'search/desktop-after.webm');
    assert.match(manifest.scenarios[1].cells[0].before.error, /^step click:/);
    assert.ok(beforeSeen.some((r) => r.url === '/next'), 'goto step ran');
    assert.ok(beforeSeen.every((r) => r.token === 'tok'), 'same-origin requests carry the header');
    await assert.rejects(stat(path.join(out, '.video-tmp')));
    assert.ok((await stat(path.join(out, 'manifest.json'))).isFile());
  } finally {
    before.close();
    afterSrv.close();
  }
});

test('records HTTP errors and blocks navigation to another origin', async (t) => {
  try {
    await (await launchChromium()).close();
  } catch (err) {
    t.skip(`Chromium cannot launch: ${String(err).split('\n')[0]}`);
    return;
  }
  const otherSeen = [];
  const other = await serve('Other', otherSeen);
  const otherUrl = `http://127.0.0.1:${other.address().port}/landing`;
  const site = http.createServer((req, res) => {
    if (req.url.startsWith('/private')) {
      res.writeHead(401, { 'content-type': 'text/html' });
      res.end('<h1>Sign in</h1>');
      return;
    }
    if (req.url.startsWith('/redirect')) {
      res.writeHead(302, { location: otherUrl });
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<h1>Home</h1><a id="out" href="${otherUrl}">Out</a><a id="priv" href="/private">Private</a>`);
  });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${site.address().port}`;
  try {
    const out = path.join(tmp, 'errors');
    const { manifest, failed, total, beforeFailed } = await capture({
      beforeUrl: base, afterUrl: base,
      scenarios: [
        { name: 'Private', path: '/private', viewports: ['desktop'], video: false, steps: [] },
        { name: 'Leave', path: '/', viewports: ['desktop'], video: false, steps: [{ click: '#out' }] },
        { name: 'Click private', path: '/', viewports: ['desktop'], video: false, steps: [{ click: '#priv' }] },
        { name: 'Redirect', path: '/redirect', viewports: ['desktop'], video: false, steps: [] },
        { name: 'Ok', path: '/', viewports: ['desktop'], video: false, steps: [] },
      ],
      viewports: { desktop: { width: 800, height: 600 } },
      outDir: out,
    });
    assert.equal(total, 5);
    assert.equal(failed, 4);
    assert.equal(beforeFailed, 4);
    const err = (i) => manifest.scenarios[i].cells[0].before.error;
    assert.equal(err(0), 'HTTP 401 at /private');
    assert.match(err(1), /^step click: navigation to another origin blocked: http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal(err(2), 'step click: HTTP 401 at /private');
    assert.match(err(3), /^navigation to another origin blocked: http:\/\/127\.0\.0\.1:\d+$/);
    assert.ok(manifest.scenarios[4].cells[0].before.screenshot);
    assert.equal(otherSeen.filter((r) => r.url === '/landing').length, 0, 'the other origin received no navigation');
  } finally {
    site.close();
    other.close();
  }
});
