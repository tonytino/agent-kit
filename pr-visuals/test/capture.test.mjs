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
    assert.equal(total, 4);
    assert.equal(failed, 2);
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
