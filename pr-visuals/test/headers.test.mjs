import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeHeaderRouteHandler, parseHeadersEnv } from '../src/headers.mjs';

function fakeRoute(url) {
  const log = [];
  const request = { url: () => url, headers: () => ({ accept: '*/*' }) };
  const route = {
    continue: async (opts) => log.push(['continue', opts]),
    fetch: async (opts) => { log.push(['fetch', opts]); return { fake: 'response' }; },
    fulfill: async (opts) => log.push(['fulfill', opts]),
    abort: async (code) => log.push(['abort', code]),
  };
  return { route, request, log };
}

const SECRET = { 'x-vercel-protection-bypass': 'secret-value' };

test('adds headers only to same-origin requests', async () => {
  const handler = makeHeaderRouteHandler('https://pr-1.example.com/some/path', SECRET);

  const same = fakeRoute('https://pr-1.example.com/api/data?x=1');
  await handler(same.route, same.request);
  assert.deepEqual(same.log[0], ['fetch', { headers: { accept: '*/*', 'x-vercel-protection-bypass': 'secret-value' }, maxRedirects: 0 }]);
  assert.deepEqual(same.log[1], ['fulfill', { response: { fake: 'response' } }]);

  for (const other of ['https://cdn.example.net/a.js', 'http://pr-1.example.com/x', 'https://pr-1.example.com:8443/x',
    'https://evil.pr-1.example.com/', 'data:text/plain,hi']) {
    const r = fakeRoute(other);
    await handler(r.route, r.request);
    assert.deepEqual(r.log, [['continue', undefined]], other);
  }
});

test('aborts the request when the fetch fails', async () => {
  const handler = makeHeaderRouteHandler('https://a.example', SECRET);
  const r = fakeRoute('https://a.example/');
  r.route.fetch = async () => { throw new Error('net'); };
  await handler(r.route, r.request);
  assert.deepEqual(r.log, [['abort', 'failed']]);
});

test('parses PR_VISUALS_HEADERS without leaking values in errors', () => {
  assert.deepEqual(parseHeadersEnv(undefined), {});
  assert.deepEqual(parseHeadersEnv('{"X-Token":"v"}'), { 'x-token': 'v' });
  assert.throws(() => parseHeadersEnv('[1]'), /JSON object/);
  assert.throws(() => parseHeadersEnv('{"bad name":"secret-value"}'), (e) => !e.message.includes('secret-value'));
  assert.throws(() => parseHeadersEnv('{"x":"secret-value\\nInjected: 1"}'), (e) => !e.message.includes('secret-value'));
  assert.throws(() => parseHeadersEnv('{"x": "secret-value'), (e) => !e.message.includes('secret-value'));
});
