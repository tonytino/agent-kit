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

test('POST is not retried on 5xx or network errors', async () => {
  const { calls, fetchImpl } = seq([json(502, {}), json(201, { id: 1 })]);
  const gh = createGitHub({ token: 't', fetchImpl, sleepImpl: async () => {} });
  await assert.rejects(gh.request('POST', '/c', { body: {} }), /returned 502/);
  assert.equal(calls.length, 1);
  let n = 0;
  const failing = createGitHub({ token: 't', fetchImpl: async () => { n++; throw new Error('reset'); }, sleepImpl: async () => {} });
  await assert.rejects(failing.request('POST', '/c', { body: {} }), /reset/);
  assert.equal(n, 1);
});

test('POST is retried on rate limits', async () => {
  const { calls, fetchImpl } = seq([json(429, {}, { 'retry-after': '2' }), json(201, { id: 1 })]);
  const gh = createGitHub({ token: 't', fetchImpl, sleepImpl: async () => {} });
  assert.deepEqual(await gh.request('POST', '/c', { body: {} }), { id: 1 });
  assert.equal(calls.length, 2);
});

test('paginate follows pages until a short page', async () => {
  const pages = [Array.from({ length: 100 }, (_, i) => i), [100, 101]];
  const seen = [];
  const gh = createGitHub({ token: 't', fetchImpl: async (url) => {
    const page = Number(new URL(url).searchParams.get('page'));
    seen.push(page);
    return new Response(JSON.stringify(pages[page - 1] ?? []), { status: 200 });
  } });
  const all = await gh.paginate('/items');
  assert.equal(all.length, 102);
  assert.deepEqual(seen, [1, 2]);
});
