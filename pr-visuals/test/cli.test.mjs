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
  assert.deepEqual(repoFromRemote('git@github.com:tonytino/agent-kit.git'), { owner: 'tonytino', repo: 'agent-kit' });
  assert.deepEqual(repoFromRemote('https://github.com/tonytino/agent-kit'), { owner: 'tonytino', repo: 'agent-kit' });
  assert.throws(() => repoFromRemote('https://gitlab.com/a/b'), /Pass --repo/);
});
