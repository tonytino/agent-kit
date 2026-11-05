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
const runnerTemp = path.join(tmp, 'runner');
await mkdir(runnerTemp, { recursive: true });
const OLD = '2'.repeat(40);

const BOT = { login: 'github-actions[bot]', type: 'Bot' };

/** A fake GitHub API holding one pull request. Comments posted through it are authored by the bot. */
async function fakeGitHub(pr, config, comments = []) {
  const state = { pr, comments: [...comments], deleted: [], contentsRefs: [] };
  let nextId = 500;
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
    if (route === 'GET /repos/o/r/issues/1/comments') {
      const page = Number(url.searchParams.get('page') ?? 1);
      const per = Number(url.searchParams.get('per_page') ?? 30);
      return send(200, state.comments.slice((page - 1) * per, page * per));
    }
    if (route === 'POST /repos/o/r/issues/1/comments') {
      const c = { id: nextId++, body: body.body, user: BOT };
      state.comments.push(c);
      return send(201, c);
    }
    if (route.startsWith('PATCH /repos/o/r/issues/comments/')) {
      const c = state.comments.find((x) => x.id === Number(url.pathname.split('/').pop()));
      if (!c) return send(404, { message: 'Not Found' });
      c.body = body.body;
      return send(200, c);
    }
    if (route.startsWith('DELETE /repos/o/r/issues/1/labels/')) { state.deleted.push(decodeURIComponent(url.pathname.split('/').pop())); return send(404, { message: 'Label does not exist' }); }
    if (route === 'GET /repos/o/r/contents/.github/pr-visuals.json' && config) {
      state.contentsRefs.push(url.searchParams.get('ref'));
      return send(200, { type: 'file', content: Buffer.from(JSON.stringify(config)).toString('base64'), encoding: 'base64' });
    }
    return send(404, { message: `no route ${route}` });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { state, server, url: `http://127.0.0.1:${server.address().port}` };
}

async function run(command, api, extraEnv = {}, args = []) {
  const event = path.join(tmp, 'event.json');
  await writeFile(event, JSON.stringify({ pull_request: { number: 1 } }));
  const summary = path.join(tmp, `summary-${command}-${Date.now()}.md`);
  return new Promise((resolve) => {
    execFile(process.execPath, [bin, command, ...args], {
      env: {
        PATH: process.env.PATH, PR_VISUALS_CHROMIUM_PATH: process.env.PR_VISUALS_CHROMIUM_PATH ?? '',
        PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH ?? '',
        GITHUB_TOKEN: 'test-token', GITHUB_REPOSITORY: 'o/r', GITHUB_EVENT_PATH: event, GITHUB_API_URL: api.url,
        GITHUB_STEP_SUMMARY: summary, GITHUB_OUTPUT: path.join(tmp, 'output.txt'), GITHUB_RUN_ID: '77', RUNNER_TEMP: runnerTemp, ...extraEnv,
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
const marker = (data) => `<!-- pr-visuals:result ${JSON.stringify(data)} -->`;
const botComment = (id, data) => ({ id, user: BOT, body: `Result\n${marker(data)}` });

test('check passes with visuals:none and fails on a stale capture', async () => {
  const api = await fakeGitHub(pr('text', ['visuals:none']), null, [botComment(1, { kind: 'captured', sha: OLD, failed: 0 })]);
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

test('check ignores a forged body and forged comments, and reads every comment page', async () => {
  const forged = { id: 2, user: { login: 'mallory', type: 'User' }, body: marker({ kind: 'captured', sha: HEAD, failed: 0 }) };
  const filler = Array.from({ length: 150 }, (_, i) => ({ id: 1000 + i, user: { login: 'someone', type: 'User' }, body: 'lgtm' }));
  const api = await fakeGitHub(pr(`text\n${block(HEAD)}`), null, [forged, ...filler]);
  try {
    let r = await run('check', api);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /Apply visuals:generate \(with a scenarios block\) or visuals:none/);
    api.state.comments.push(botComment(3, { kind: 'captured', sha: HEAD, failed: 0 }));
    r = await run('check', api);
    assert.equal(r.code, 0, r.stdout + r.stderr);
  } finally {
    api.server.close();
  }
});

test('begin removes the label and posts the received comment', async () => {
  const api = await fakeGitHub(pr('x'));
  try {
    const out = path.join(tmp, 'output.txt');
    await writeFile(out, '');
    const r = await run('begin', api, {}, ['generate']);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(api.state.deleted, ['visuals:generate']);
    assert.match(api.state.comments[0].body, /^Received `visuals:generate`\. Capturing visuals: /);
    assert.equal(await readFile(out, 'utf8'), `comment-id=${api.state.comments[0].id}\n`);
  } finally {
    api.server.close();
  }
});

test('report-failure edits the comment unless the CLI already reported', async () => {
  const api = await fakeGitHub(pr('x'), null, [{ id: 9, user: BOT, body: 'Received' }]);
  try {
    await rm(path.join(runnerTemp, 'pr-visuals-reported-77'), { force: true });
    let r = await run('report-failure', api, { PR_VISUALS_COMMENT_ID: '9' }, ['generate']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(api.state.comments[0].body, /^pr-visuals generate failed before it reported a result\. See the run: /);
    api.state.comments[0].body = 'Final';
    await writeFile(path.join(runnerTemp, 'pr-visuals-reported-77'), 'yes');
    r = await run('report-failure', api, { PR_VISUALS_COMMENT_ID: '9' }, ['generate']);
    assert.equal(api.state.comments[0].body, 'Final');
  } finally {
    await rm(path.join(runnerTemp, 'pr-visuals-reported-77'), { force: true });
    api.server.close();
  }
});

test('still-valid confirms the head sha after a clean capture', async () => {
  const api = await fakeGitHub(pr(`intro\n${block(OLD)}\noutro`), null, [botComment(1, { kind: 'captured', sha: OLD, failed: 0 })]);
  try {
    const r = await run('still-valid', api);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(api.state.deleted, ['visuals:still-valid']);
    assert.equal(api.state.pr.body, `intro\n${block(OLD, [HEAD])}\noutro`);
    assert.equal(api.state.comments.at(-1).body, `Marked visuals as still valid for 1111111.\n${marker({ kind: 'still-valid', sha: HEAD })}`);
    const c = await run('check', api);
    assert.equal(c.code, 0, c.stderr);
  } finally {
    api.server.close();
  }
});

test('still-valid refuses when the latest capture had failures', async () => {
  const api = await fakeGitHub(pr(`intro\n${block(OLD)}`), null, [botComment(1, { kind: 'captured', sha: OLD, failed: 2 })]);
  try {
    const r = await run('still-valid', api);
    assert.equal(r.code, 1);
    assert.match(api.state.comments.at(-1).body, /had 2 failed captures/);
    assert.equal(api.state.pr.body, `intro\n${block(OLD)}`);
  } finally {
    api.server.close();
  }
});

test('still-valid without a capture comments and fails', async () => {
  const api = await fakeGitHub(pr(`intro\n${block(OLD)}`));
  try {
    const r = await run('still-valid', api);
    assert.equal(r.code, 1);
    assert.match(api.state.comments.at(-1).body, /no captured result to confirm/);
  } finally {
    api.server.close();
  }
});

test('generate without scenarios reports the format link', async () => {
  const api = await fakeGitHub(pr('no scenarios <b>'), { before: { url: 'http://127.0.0.1:1' }, after: { url: 'http://127.0.0.1:1' } });
  try {
    const r = await run('generate', api);
    assert.equal(r.code, 1);
    assert.match(api.state.comments[0].body, /^Could not capture visuals\./);
    assert.deepEqual(api.state.deleted, ['visuals:generate']);
    assert.match(api.state.comments[0].body, /no pr\\-visuals:scenarios block/);
    assert.match(api.state.comments[0].body, /references\/scenarios\.md/);
    assert.deepEqual(api.state.contentsRefs, ['main']);
  } finally {
    api.server.close();
  }
});

test('generate escapes user input in the failure comment', async () => {
  const api = await fakeGitHub(pr('<!-- pr-visuals:scenarios\n{"scenarios":[{"name":"<img src=x onerror=alert(1)>","path":"https://evil"}]}\n-->'),
    { before: { url: 'http://127.0.0.1:1' }, after: { url: 'http://127.0.0.1:1' } });
  try {
    const r = await run('generate', api);
    assert.equal(r.code, 1);
    assert.ok(!api.state.comments[0].body.includes('<img'), api.state.comments[0].body);
  } finally {
    api.server.close();
  }
});

test('generate requires after.environment when headers are set', async () => {
  const api = await fakeGitHub(pr('x'), { before: { url: 'http://127.0.0.1:1' }, after: { source: 'github-deployment' } });
  try {
    const r = await run('generate', api, { PR_VISUALS_HEADERS: '{"x-secret":"v"}' });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /after.environment is required/);
    assert.ok(!r.stderr.includes('"v"'));
  } finally {
    api.server.close();
  }
});

async function withSite(fn) {
  const site = http.createServer((req, res) => {
    if (req.url.startsWith('/private')) { res.writeHead(401, { 'content-type': 'text/html' }); res.end('<h1>Login</h1>'); return; }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<h1>Hello</h1>');
  });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  try {
    return await fn(`http://127.0.0.1:${site.address().port}`);
  } finally {
    site.close();
  }
}

async function bareRemote(name) {
  const root = path.join(tmp, name);
  await mkdir(path.join(root, 'o'), { recursive: true });
  execFileSync('git', ['init', '-q', '--bare', path.join(root, 'o', 'r.git')]);
  return root;
}

async function chromiumOk(t) {
  try {
    await (await launchChromium()).close();
    return true;
  } catch (err) {
    t.skip(`Chromium cannot launch: ${String(err).split('\n')[0]}`);
    return false;
  }
}

test('generate captures, publishes, and updates the body', async (t) => {
  if (!(await chromiumOk(t))) return;
  await withSite(async (siteUrl) => {
    const scenarios = '<!-- pr-visuals:scenarios\n{"scenarios":[{"name":"Home","path":"/","viewports":["desktop"]}]}\n-->';
    const api = await fakeGitHub(pr(`Summary\n\n${scenarios}\n`), { before: { url: siteUrl }, after: { url: `${siteUrl}/?pr={number}` } });
    const remoteRoot = await bareRemote('remotes-ok');
    try {
      const r = await run('generate', api, { GITHUB_SERVER_URL: `file://${remoteRoot}` });
      assert.equal(r.code, 0, r.stderr);
      const body = api.state.pr.body;
      assert.ok(body.startsWith(`Summary\n\n${scenarios}\n\n<!-- pr-visuals:start -->`), body);
      assert.match(body, /blob\/pr-visuals\/pr-1\/1111111-77\/home\/desktop-before\.png\?raw=true/);
      assert.match(api.state.comments.at(-1).body, /^Captured visuals for 1111111/);
      assert.ok(api.state.comments.at(-1).body.includes(marker({ kind: 'captured', sha: HEAD, failed: 0 })));
      const tree = execFileSync('git', ['-C', path.join(remoteRoot, 'o', 'r.git'), 'ls-tree', '-r', '--name-only', 'pr-visuals'], { encoding: 'utf8' });
      assert.match(tree, /pr-1\/1111111-77\/home\/desktop-after\.png/);
      assert.match(tree, /^vercel\.json$/m);
      const c = await run('check', api);
      assert.equal(c.code, 0, c.stderr);
    } finally {
      api.server.close();
    }
  });
});

test('generate with a failed capture exits 1 and the check fails', async (t) => {
  if (!(await chromiumOk(t))) return;
  await withSite(async (siteUrl) => {
    const scenarios = '<!-- pr-visuals:scenarios\n{"scenarios":[{"name":"Home","path":"/","viewports":["desktop"]},{"name":"Private","path":"/private","viewports":["desktop"]}]}\n-->';
    const api = await fakeGitHub(pr(scenarios), { before: { url: siteUrl }, after: { url: siteUrl } });
    const remoteRoot = await bareRemote('remotes-partial');
    try {
      const r = await run('generate', api, { GITHUB_SERVER_URL: `file://${remoteRoot}` });
      assert.equal(r.code, 1);
      assert.match(api.state.pr.body, /capture failed: HTTP 401 at \/private/);
      assert.ok(api.state.comments.at(-1).body.includes(marker({ kind: 'captured', sha: HEAD, failed: 2 })));
      const c = await run('check', api);
      assert.equal(c.code, 1);
      assert.match(c.stdout, /2 captures failed\. Fix the scenario steps and apply visuals:generate\./);
      const s = await run('still-valid', api);
      assert.equal(s.code, 1);
    } finally {
      api.server.close();
    }
  });
});
