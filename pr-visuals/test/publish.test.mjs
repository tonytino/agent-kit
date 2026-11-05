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

async function setup(name) {
  const bare = path.join(tmp, `${name}.git`);
  execFileSync('git', ['init', '-q', '--bare', bare]);
  execFileSync('git', ['-C', bare, 'config', 'uploadpack.allowFilter', 'true']);
  const src = path.join(tmp, `${name}-src`);
  await mkdir(path.join(src, 'home'), { recursive: true });
  await writeFile(path.join(src, 'home', 'desktop-before.png'), `${name} before`);
  await writeFile(path.join(src, 'home', 'desktop-after.png'), `${name} after`);
  return { bare, src, remote: `file://${bare}`, files: ['home/desktop-before.png', 'home/desktop-after.png'] };
}
const lsTree = (bare) => execFileSync('git', ['-C', bare, 'ls-tree', '-r', '--name-only', 'pr-visuals'], { encoding: 'utf8' }).trim().split('\n').sort();
const show = (bare, file) => execFileSync('git', ['-C', bare, 'show', `pr-visuals:${file}`], { encoding: 'utf8' });

test('publishes to an orphan branch and appends on the next run', async () => {
  const { bare, src, remote, files } = await setup('append');
  await publishFiles({ remote, srcDir: src, files, dest: 'pr-1/abcdef0-1', message: 'first' });
  await publishFiles({ remote, srcDir: src, files, dest: 'pr-1/abcdef0-2', message: 'second' });
  await publishFiles({ remote, srcDir: src, files, dest: 'pr-2/abcdef0-3', message: 'third' });
  assert.deepEqual(lsTree(bare), [
    'pr-1/abcdef0-1/home/desktop-after.png', 'pr-1/abcdef0-1/home/desktop-before.png',
    'pr-1/abcdef0-2/home/desktop-after.png', 'pr-1/abcdef0-2/home/desktop-before.png',
    'pr-2/abcdef0-3/home/desktop-after.png', 'pr-2/abcdef0-3/home/desktop-before.png',
    'vercel.json',
  ]);
  const log = execFileSync('git', ['-C', bare, 'log', '--format=%s', 'pr-visuals'], { encoding: 'utf8' }).trim();
  assert.equal(log, 'third\nsecond\nfirst');
  assert.equal(show(bare, 'pr-1/abcdef0-1/home/desktop-before.png'), 'append before');
});

test('writes vercel.json that disables Vercel deployments, and restores it', async () => {
  const { bare, src, remote, files } = await setup('vercel');
  await publishFiles({ remote, srcDir: src, files, dest: 'pr-1/a-1', message: 'first' });
  assert.deepEqual(JSON.parse(show(bare, 'vercel.json')), { git: { deploymentEnabled: false } });
  // Someone replaces the file on the branch. The next publish puts it back.
  const work = path.join(tmp, 'vercel-work');
  execFileSync('git', ['clone', '-q', '-b', 'pr-visuals', remote, work]);
  await writeFile(path.join(work, 'vercel.json'), '{}');
  execFileSync('git', ['-C', work, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qam', 'edit']);
  execFileSync('git', ['-C', work, 'push', '-q', 'origin', 'pr-visuals']);
  await publishFiles({ remote, srcDir: src, files, dest: 'pr-1/a-2', message: 'second' });
  assert.deepEqual(JSON.parse(show(bare, 'vercel.json')), { git: { deploymentEnabled: false } });
});

test('does not download the blobs of earlier screenshots', async () => {
  const { bare, src, remote, files } = await setup('blobs');
  const old = path.join(tmp, 'blobs-old');
  await mkdir(path.join(old, 'home'), { recursive: true });
  await writeFile(path.join(old, 'home', 'desktop-before.png'), 'old screenshot 1');
  await writeFile(path.join(old, 'home', 'desktop-after.png'), 'old screenshot 2');
  await publishFiles({ remote, srcDir: old, files, dest: 'pr-1/old-1', message: 'old' });
  const oldBlob = execFileSync('git', ['-C', bare, 'rev-parse', 'pr-visuals:pr-1/old-1/home/desktop-before.png'], { encoding: 'utf8' }).trim();
  let blobs = [];
  await publishFiles({
    remote, srcDir: src, files, dest: 'pr-1/new-2', message: 'new',
    hooks: {
      inspect: async (gitDir) => {
        const out = execFileSync('git', ['-C', gitDir, 'cat-file', '--batch-all-objects', '--batch-check=%(objecttype) %(objectname)'], { encoding: 'utf8' });
        blobs = out.trim().split('\n').filter((l) => l.startsWith('blob ')).map((l) => l.slice(5));
      },
    },
  });
  assert.equal(blobs.length, 3, 'two new screenshots and vercel.json');
  assert.ok(!blobs.includes(oldBlob));
  assert.equal(show(bare, 'pr-1/old-1/home/desktop-before.png'), 'old screenshot 1');
});

test('retries after a racing push and keeps both commits', async () => {
  const { bare, src, remote, files } = await setup('race');
  await publishFiles({ remote, srcDir: src, files, dest: 'pr-1/base-1', message: 'base' });
  const attempts = [];
  const logs = [];
  await publishFiles({
    remote, srcDir: src, files, dest: 'pr-2/mine-2', message: 'mine', log: (m) => logs.push(m),
    hooks: {
      beforePush: async (attempt) => {
        attempts.push(attempt);
        if (attempt === 1) await publishFiles({ remote, srcDir: src, files, dest: 'pr-3/racer-3', message: 'racer' });
      },
    },
  });
  assert.deepEqual(attempts, [1, 2]);
  assert.match(logs.join('\n'), /Push rejected, retrying/);
  const log = execFileSync('git', ['-C', bare, 'log', '--format=%s', 'pr-visuals'], { encoding: 'utf8' }).trim();
  assert.equal(log, 'mine\nracer\nbase');
  const tree = lsTree(bare);
  for (const d of ['pr-1/base-1', 'pr-2/mine-2', 'pr-3/racer-3']) assert.ok(tree.includes(`${d}/home/desktop-after.png`), d);
});

test('rejects unsafe file paths and remotes', async () => {
  await assert.rejects(publishFiles({ remote: 'file:///x', srcDir: tmp, files: ['../etc/passwd'], dest: 'p', message: 'm' }), /unsafe path/);
  await assert.rejects(publishFiles({ remote: '--upload-pack=x', srcDir: tmp, files: ['a.png'], dest: 'p', message: 'm' }), /Invalid git remote/);
  await assert.rejects(publishFiles({ remote: 'file:///x', srcDir: tmp, files: ['a.png'], dest: '../p', message: 'm' }), /Invalid base path/);
});
