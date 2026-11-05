import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import { launchChromium } from '../src/capture.mjs';

const bin = fileURLToPath(new URL('../cli/pr-visuals.mjs', import.meta.url));
const tmp = await mkdtemp(path.join(os.tmpdir(), 'pr-visuals-ci-test-'));
after(() => rm(tmp, { recursive: true, force: true }));
const HEAD = '1'.repeat(40);
const OLD = '2'.repeat(40);

/** A fake GitHub API holding one pull request. */
async function fakeGitHub(pr, config) {
  const state = { pr, comments: [], edits: [], deleted: [] };
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : undefined;
    const send = (status, data) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data ?? {})); };
    const url = new URL(req.url, 'http://x');
    const route = `${req.method} ${url.pathname}`;
    if (req.headers.authorization !== 'Bearer test-token') return send(401, { message: 'Bad credentials' });
    if (route === 'GET /repos/o/r/pulls/1') return send(200, state.pr);
    if (route === 'PATCH /repos/o/r/pulls/1') { state.pr.body = body.body; return send(200, state.pr); }
    if (route === 'POST /repos/o/r/issues/1/comments') { state.comments.push(body.body); return send(201, { id: 100 + state.comments.length }); }
    if (route.startsWith('PATCH /repos/o/r/issues/comments/')) { state.edits.push(body.body); return send(200, {}); }
    if (route.startsWith('DELETE /repos/o/r/issues/1/labels/')) { state.deleted.push(decodeURIComponent(url.pathname.split('/').pop())); return send(404, { message: 'Label does not exist' }); }
    if (route === 'GET /repos/o/r/contents/.github/pr-visuals.json') {
      return send(200, { content: Buffer.from(JSON.stringify(config)).toString('base64'), encoding: 'base64' });
    }
    return send(404, { message: `no route ${route}` });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { state, server, url: `http://127.0.0.1:${server.address().port}` };
}

async function run(command, api, extraEnv = {}) {
  const event = path.join(tmp, 'event.json');
  await writeFile(event, JSON.stringify({ pull_request: { number: 1 } }));
  const summary = path.join(tmp, `summary-${command}-${Date.now()}.md`);
  return new Promise((resolve) => {
    execFile(process.execPath, [bin, command], {
      env: {
        PATH: process.env.PATH, PR_VISUALS_CHROMIUM_PATH: process.env.PR_VISUALS_CHROMIUM_PATH ?? '',
        PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH ?? '',
        GITHUB_TOKEN: 'test-token', GITHUB_REPOSITORY: 'o/r', GITHUB_EVENT_PATH: event, GITHUB_API_URL: api.url,
        GITHUB_STEP_SUMMARY: summary, GITHUB_RUN_ID: '77', GITHUB_WORKSPACE: tmp, ...extraEnv,
      },
    }, async (err, stdout, stderr) => {
      const text = await readFile(summary, 'utf8').catch(() => '');
      resolve({ code: err ? err.code : 0, stdout, stderr, summary: text });
    });
  });
}

const pr = (body, labels = []) => ({ body, head: { sha: HEAD }, base: { ref: 'main' }, labels: labels.map((name) => ({ name })) });
const block = (sha, confirmed = []) =>
  `<!-- pr-visuals:start -->\n<!-- pr-visuals:meta ${JSON.stringify({ version: 1, sha, confirmed })} -->\n## Visuals\n<!-- pr-visuals:end -->`;

test('check passes with visuals:none and fails on a stale block', async () => {
  const api = await fakeGitHub(pr('text', ['visuals:none']));
  try {
    let r = await run('check', api);
    assert.equal(r.code, 0, r.stderr);
    api.state.pr = pr(`text\n${block(OLD)}`);
    r = await run('check', api);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /::error title=pr-visuals::Visuals were captured on 2222222/);
    assert.match(r.summary, /Failed: Visuals were captured on 2222222/);
  } finally {
    api.server.close();
  }
});

test('still-valid confirms the head sha', async () => {
  const api = await fakeGitHub(pr(`intro\n${block(OLD)}\noutro`));
  try {
    const r = await run('still-valid', api);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(api.state.deleted, ['visuals:still-valid']);
    assert.equal(api.state.pr.body, `intro\n${block(OLD, [HEAD])}\noutro`);
    assert.deepEqual(api.state.comments, ['Marked visuals as still valid for 1111111.']);
    const c = await run('check', api);
    assert.equal(c.code, 0, c.stderr);
  } finally {
    api.server.close();
  }
});

test('still-valid without a block comments and fails', async () => {
  const api = await fakeGitHub(pr('no block'));
  try {
    const r = await run('still-valid', api);
    assert.equal(r.code, 1);
    assert.match(api.state.comments[0], /no visuals block/);
  } finally {
    api.server.close();
  }
});

test('generate without scenarios reports the format link', async () => {
  const api = await fakeGitHub(pr('no scenarios'), { before: { url: 'http://127.0.0.1:1' }, after: { url: 'http://127.0.0.1:1' } });
  try {
    const r = await run('generate', api);
    assert.equal(r.code, 1);
    assert.match(api.state.comments[0], /^Received `visuals:generate`\. Capturing visuals: /);
    assert.deepEqual(api.state.deleted, ['visuals:generate']);
    assert.match(api.state.edits.at(-1), /no pr-visuals:scenarios block/);
    assert.match(api.state.edits.at(-1), /references\/scenarios\.md/);
  } finally {
    api.server.close();
  }
});

test('generate captures, publishes, and updates the body', async (t) => {
  try {
    await (await launchChromium()).close();
  } catch (err) {
    t.skip(`Chromium cannot launch: ${String(err).split('\n')[0]}`);
    return;
  }
  const site = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<h1>Hello</h1>'); });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  const siteUrl = `http://127.0.0.1:${site.address().port}`;
  const scenarios = '<!-- pr-visuals:scenarios\n{"scenarios":[{"name":"Home","path":"/","viewports":["desktop"]}]}\n-->';
  const api = await fakeGitHub(pr(`Summary\n\n${scenarios}\n`), { before: { url: siteUrl }, after: { url: `${siteUrl}/?pr={number}` } });
  const remoteRoot = path.join(tmp, 'remotes');
  await mkdir(path.join(remoteRoot, 'o'), { recursive: true });
  execFileSync('git', ['init', '-q', '--bare', path.join(remoteRoot, 'o', 'r.git')]);
  try {
    const r = await run('generate', api, { GITHUB_SERVER_URL: `file://${remoteRoot}` });
    assert.equal(r.code, 0, r.stderr);
    const body = api.state.pr.body;
    assert.ok(body.startsWith(`Summary\n\n${scenarios}\n\n<!-- pr-visuals:start -->`), body);
    assert.match(body, /blob\/pr-visuals\/pr-1\/1111111-77\/home\/desktop-before\.png\?raw=true/);
    assert.match(api.state.edits.at(-1), /^Captured visuals for 1111111/);
    const tree = execFileSync('git', ['-C', path.join(remoteRoot, 'o', 'r.git'), 'ls-tree', '-r', '--name-only', 'pr-visuals'], { encoding: 'utf8' });
    assert.match(tree, /pr-1\/1111111-77\/home\/desktop-after\.png/);
    const c = await run('check', api);
    assert.equal(c.code, 0, c.stderr);
  } finally {
    site.close();
    api.server.close();
  }
});
