import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveDeploymentUrl } from '../src/deployments.mjs';
import { createGitHub } from '../src/github.mjs';

const SHA = 'f'.repeat(40);

/**
 * Builds a fake fetch. `rounds` is a list of states, one per poll: { deployments, statuses: { id: [...] } }.
 */
function fakeApi(rounds) {
  const calls = [];
  let poll = -1;
  const fetchImpl = async (url) => {
    const u = new URL(url);
    calls.push(u);
    let data;
    if (u.pathname === '/repos/o/r/deployments') {
      poll = Math.min(poll + 1, rounds.length - 1);
      data = rounds[poll].deployments;
    } else {
      const id = u.pathname.split('/')[5];
      data = rounds[poll].statuses[id] ?? [];
    }
    return new Response(JSON.stringify(data), { status: 200 });
  };
  return { gh: createGitHub({ token: 't', fetchImpl, sleepImpl: async () => {} }), calls };
}

function clock() {
  let t = 0;
  return { now: () => t, sleepImpl: async (ms) => { t += ms; } };
}

test('returns environment_url of the newest successful deployment', async () => {
  const { gh, calls } = fakeApi([{
    deployments: [
      { id: 1, sha: SHA, created_at: '2026-01-01T00:00:00Z' },
      { id: 2, sha: SHA, created_at: '2026-01-02T00:00:00Z' },
    ],
    statuses: {
      1: [{ state: 'success', environment_url: 'https://old.example' }],
      2: [{ state: 'inactive' }, { state: 'success', environment_url: 'https://new.example', target_url: 'https://logs.example' }],
    },
  }]);
  const url = await resolveDeploymentUrl({ gh, owner: 'o', repo: 'r', sha: SHA, timeoutMs: 60000, ...clock() });
  assert.equal(url, 'https://new.example');
  assert.equal(calls[0].searchParams.get('sha'), SHA);
  assert.equal(calls[0].searchParams.has('environment'), false);
});

test('falls back to target_url', async () => {
  const { gh } = fakeApi([{ deployments: [{ id: 5, sha: SHA }], statuses: { 5: [{ state: 'success', target_url: 'https://t.example' }] } }]);
  assert.equal(await resolveDeploymentUrl({ gh, owner: 'o', repo: 'r', sha: SHA, timeoutMs: 1000, ...clock() }), 'https://t.example');
});

test('polls while pending, then succeeds', async () => {
  const c = clock();
  const { gh } = fakeApi([
    { deployments: [], statuses: {} },
    { deployments: [{ id: 7, sha: SHA }], statuses: { 7: [{ state: 'pending' }] } },
    { deployments: [{ id: 7, sha: SHA }], statuses: { 7: [{ state: 'success', environment_url: 'https://pr.example' }, { state: 'pending' }] } },
  ]);
  const url = await resolveDeploymentUrl({ gh, owner: 'o', repo: 'r', sha: SHA, timeoutMs: 15 * 60000, ...c });
  assert.equal(url, 'https://pr.example');
  assert.equal(c.now(), 30000);
});

test('times out with a clear error', async () => {
  const { gh } = fakeApi([{ deployments: [{ id: 1, sha: SHA }], statuses: { 1: [{ state: 'failure' }] } }]);
  await assert.rejects(
    resolveDeploymentUrl({ gh, owner: 'o', repo: 'r', sha: SHA, environment: 'Preview', timeoutMs: 60000, ...clock() }),
    /No successful deployment in environment "Preview" for fffffff after 1 minutes/,
  );
});

test('passes the environment filter', async () => {
  const { gh, calls } = fakeApi([{ deployments: [{ id: 3, sha: SHA }], statuses: { 3: [{ state: 'success', environment_url: 'https://p.example' }] } }]);
  await resolveDeploymentUrl({ gh, owner: 'o', repo: 'r', sha: SHA, environment: 'Preview', timeoutMs: 1000, ...clock() });
  assert.equal(calls[0].searchParams.get('environment'), 'Preview');
});
