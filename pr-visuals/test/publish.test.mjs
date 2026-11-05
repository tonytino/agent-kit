import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { destPath, gitEnv, publishFiles } from '../src/publish.mjs';

const tmp = await mkdtemp(path.join(os.tmpdir(), 'pr-visuals-pub-test-'));
after(() => rm(tmp, { recursive: true, force: true }));
const SHA = 'abcdef0'.padEnd(40, '1');

test('destPath builds a safe path', () => {
  assert.equal(destPath({ pr: 12, sha: SHA, runId: '999' }), 'pr-12/abcdef0-999');
  assert.equal(destPath({ pr: 12, sha: SHA, runId: '999', runAttempt: '2' }), 'pr-12/abcdef0-999-2');
  assert.match(destPath({ pr: 1, sha: SHA, runId: '../x' }), /^pr-1\/abcdef0-\d+$/);
  assert.throws(() => destPath({ pr: 0, sha: SHA }), /positive integer/);
});

test('gitEnv passes the token through config env, not argv or URL', () => {
  const env = gitEnv('tok', 'https://github.com');
  assert.equal(env.GIT_CONFIG_KEY_0, 'http.https://github.com/.extraheader');
  assert.equal(env.GIT_CONFIG_VALUE_0, `AUTHORIZATION: basic ${Buffer.from('x-access-token:tok').toString('base64')}`);
  assert.equal(gitEnv(undefined).GIT_CONFIG_COUNT, process.env.GIT_CONFIG_COUNT);
});

test('publishes to an orphan branch and appends on the next run', async () => {
  const bare = path.join(tmp, 'remote.git');
  execFileSync('git', ['init', '-q', '--bare', bare]);
  execFileSync('git', ['-C', bare, 'config', 'uploadpack.allowFilter', 'true']);
  const src = path.join(tmp, 'src');
  await mkdir(path.join(src, 'home'), { recursive: true });
  await writeFile(path.join(src, 'home', 'desktop-before.png'), 'png');
  await writeFile(path.join(src, 'home', 'desktop-after.png'), 'png2');
  const files = ['home/desktop-before.png', 'home/desktop-after.png'];
  const remote = `file://${bare}`;
  await publishFiles({ remote, srcDir: src, files, dest: 'pr-1/abcdef0-1', message: 'first' });
  await publishFiles({ remote, srcDir: src, files, dest: 'pr-2/abcdef0-2', message: 'second' });
  const tree = execFileSync('git', ['-C', bare, 'ls-tree', '-r', '--name-only', 'pr-visuals'], { encoding: 'utf8' }).trim().split('\n');
  assert.deepEqual(tree.sort(), [
    'pr-1/abcdef0-1/home/desktop-after.png', 'pr-1/abcdef0-1/home/desktop-before.png',
    'pr-2/abcdef0-2/home/desktop-after.png', 'pr-2/abcdef0-2/home/desktop-before.png',
  ]);
  const log = execFileSync('git', ['-C', bare, 'log', '--format=%s', 'pr-visuals'], { encoding: 'utf8' }).trim();
  assert.equal(log, 'second\nfirst');
});

test('rejects unsafe file paths and remotes', async () => {
  await assert.rejects(publishFiles({ remote: 'file:///x', srcDir: tmp, files: ['../etc/passwd'], dest: 'p', message: 'm' }), /unsafe path/);
  await assert.rejects(publishFiles({ remote: '--upload-pack=x', srcDir: tmp, files: ['a.png'], dest: 'p', message: 'm' }), /Invalid git remote/);
  await assert.rejects(publishFiles({ remote: 'file:///x', srcDir: tmp, files: ['a.png'], dest: '../p', message: 'm' }), /Invalid base path/);
});
