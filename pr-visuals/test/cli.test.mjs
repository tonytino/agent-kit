import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import { repoFromRemote } from '../src/cli.mjs';

const bin = fileURLToPath(new URL('../cli/pr-visuals.mjs', import.meta.url));
const tmp = await mkdtemp(path.join(os.tmpdir(), 'pr-visuals-cli-test-'));
after(() => rm(tmp, { recursive: true, force: true }));

test('--help lists commands', () => {
  const out = execFileSync(process.execPath, [bin, '--help'], { encoding: 'utf8' });
  for (const cmd of ['check', 'generate', 'still-valid', 'capture', 'render', 'publish']) assert.match(out, new RegExp(`\\b${cmd}\\b`));
});

test('unknown command exits 2', () => {
  assert.equal(spawnSync(process.execPath, [bin, 'nope']).status, 2);
});

test('render prints the visuals block', async () => {
  const manifest = path.join(tmp, 'manifest.json');
  await writeFile(manifest, JSON.stringify({ version: 1, scenarios: [{ name: 'Home', slug: 'home', video: false,
    cells: [{ viewport: 'desktop', before: { screenshot: 'home/desktop-before.png' }, after: { screenshot: 'home/desktop-after.png' } }] }] }));
  const sha = 'a'.repeat(40);
  const out = execFileSync(process.execPath, [bin, 'render', '--manifest', manifest, '--repo', 'o/r', '--pr', '3', '--sha', sha, '--base-path', 'pr-3/aaaaaaa-1'], { encoding: 'utf8' });
  assert.match(out, /^<!-- pr-visuals:start -->/);
  assert.match(out, /blob\/pr-visuals\/pr-3\/aaaaaaa-1\/home\/desktop-after\.png\?raw=true/);
});

test('check fails without a token', () => {
  const event = path.join(tmp, 'event.json');
  execFileSync('sh', ['-c', `echo '{"pull_request":{"number":1}}' > "$0"`, event]);
  const r = spawnSync(process.execPath, [bin, 'check'], { env: { PATH: process.env.PATH, GITHUB_REPOSITORY: 'o/r', GITHUB_EVENT_PATH: event }, encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /GITHUB_TOKEN is not set/);
});

test('repoFromRemote parses GitHub remotes', () => {
  assert.deepEqual(repoFromRemote('git@github.com:tonytino/agent-sdk.git'), { owner: 'tonytino', repo: 'agent-sdk' });
  assert.deepEqual(repoFromRemote('https://github.com/tonytino/agent-sdk'), { owner: 'tonytino', repo: 'agent-sdk' });
  assert.throws(() => repoFromRemote('https://gitlab.com/a/b'), /Pass --repo/);
});

test('each command has its own --help', () => {
  for (const cmd of ['check', 'generate', 'still-valid', 'capture', 'render', 'publish']) {
    const out = execFileSync(process.execPath, [bin, cmd, '--help'], { encoding: 'utf8' });
    assert.match(out, new RegExp(`^Usage: pr-visuals ${cmd}`), cmd);
  }
});

test('bad options give a clear error and the command usage', () => {
  const r = spawnSync(process.execPath, [bin, 'render', '--nope'], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Unknown option '--nope'/);
  assert.match(r.stderr, /Usage: pr-visuals render/);
  assert.doesNotMatch(r.stderr, /at parseArgs|node:internal/);
});

test('capture refuses a symlinked scenarios file', async () => {
  const { symlink } = await import('node:fs/promises');
  const real = path.join(tmp, 'sc.json');
  await writeFile(real, '{"scenarios":[{"name":"a","path":"/"}]}');
  await symlink(real, path.join(tmp, 'sc-link.json'));
  const r = spawnSync(process.execPath, [bin, 'capture', '--before-url', 'http://127.0.0.1:1', '--after-url', 'http://127.0.0.1:1',
    '--scenarios', path.join(tmp, 'sc-link.json'), '--out', path.join(tmp, 'o')], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /is a symlink/);
});
