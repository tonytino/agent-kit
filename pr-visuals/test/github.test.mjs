import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGitHub } from '../src/github.mjs';

const seq = (responses) => {
  let i = 0;
  const calls = [];
  return { calls, fetchImpl: async (url, init) => { calls.push({ url: String(url), init }); return responses[Math.min(i++, responses.length - 1)](); } };
};
const json = (status, body, headers = {}) => () => new Response(JSON.stringify(body), { status, headers });

test('retries 5xx and secondary rate limits', async () => {
  const { calls, fetchImpl } = seq([json(502, {}), json(403, { message: 'You have exceeded a secondary rate limit' }, { 'retry-after': '1' }), json(200, { ok: 1 })]);
  const waits = [];
  const gh = createGitHub({ token: 'tok', fetchImpl, sleepImpl: async (ms) => waits.push(ms) });
  assert.deepEqual(await gh.request('GET', '/x'), { ok: 1 });
  assert.equal(calls.length, 3);
  assert.equal(waits[1], 1000);
  assert.equal(calls[0].init.headers.authorization, 'Bearer tok');
});

test('gives clear errors without the token', async () => {
  for (const [status, re] of [[401, /invalid/], [403, /permissions/], [404, /not found/]]) {
    const gh = createGitHub({ token: 'super-secret', fetchImpl: seq([json(status, { message: 'm' })]).fetchImpl, sleepImpl: async () => {} });
    await assert.rejects(gh.request('GET', '/y'), (e) => re.test(e.message) && !e.message.includes('super-secret'));
  }
});

test('allow404 returns null', async () => {
  const gh = createGitHub({ token: 't', fetchImpl: seq([json(404, {})]).fetchImpl });
  assert.equal(await gh.request('DELETE', '/z', { allow404: true }), null);
});
