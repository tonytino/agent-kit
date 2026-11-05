import assert from 'node:assert/strict';
import { test } from 'node:test';
import { browserEnv, makeRouteHandler, parseHeadersEnv } from '../src/headers.mjs';

function fakeRoute(url, { navigation = false, mainFrame = true } = {}) {
  const log = [];
  const frame = { parentFrame: () => (mainFrame ? null : {}) };
  const request = { url: () => url, headers: () => ({ accept: '*/*' }), isNavigationRequest: () => navigation, frame: () => frame };
  const route = {
    continue: async (opts) => log.push(['continue', opts]),
    fetch: async (opts) => { log.push(['fetch', opts]); return { fake: 'response', status: () => 200, headers: () => ({}) }; },
    fulfill: async (opts) => log.push(['fulfill', opts]),
    abort: async (code) => log.push(['abort', code]),
  };
  return { route, request, log };
}

const SECRET = { 'x-vercel-protection-bypass': 'secret-value' };

test('adds headers only to same-origin requests', async () => {
  const handler = makeRouteHandler({ origin: 'https://pr-1.example.com/some/path', headers: SECRET });

  const same = fakeRoute('https://pr-1.example.com/api/data?x=1');
  await handler(same.route, same.request);
  assert.deepEqual(same.log[0], ['fetch', { headers: { accept: '*/*', 'x-vercel-protection-bypass': 'secret-value' }, maxRedirects: 0 }]);
  assert.equal(same.log[1][0], 'fulfill');

  for (const other of ['https://cdn.example.net/a.js', 'http://pr-1.example.com/x', 'https://pr-1.example.com:8443/x',
    'https://evil.pr-1.example.com/', 'data:text/plain,hi']) {
    const r = fakeRoute(other);
    await handler(r.route, r.request);
    assert.deepEqual(r.log, [['continue', undefined]], other);
  }
});

test('aborts the request when the fetch fails', async () => {
  const handler = makeRouteHandler({ origin: 'https://a.example', headers: SECRET });
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

test('without headers, same-origin requests continue unchanged', async () => {
  const handler = makeRouteHandler({ origin: 'https://a.example' });
  const r = fakeRoute('https://a.example/x');
  await handler(r.route, r.request);
  assert.deepEqual(r.log, [['continue', undefined]]);
});

test('blocks main-frame navigations to another origin', async () => {
  const blocked = [];
  const handler = makeRouteHandler({ origin: 'https://a.example', headers: SECRET, onBlocked: (u) => blocked.push(u) });
  const nav = fakeRoute('https://evil.example/login', { navigation: true });
  await handler(nav.route, nav.request);
  assert.deepEqual(nav.log, [['abort', 'blockedbyclient']]);
  assert.deepEqual(blocked, ['https://evil.example/login']);
  const iframe = fakeRoute('https://embed.example/', { navigation: true, mainFrame: false });
  await handler(iframe.route, iframe.request);
  assert.deepEqual(iframe.log, [['continue', undefined]]);
});

test('browserEnv drops tokens and runner secrets', () => {
  const env = browserEnv({ PATH: '/bin', HOME: '/h', GITHUB_TOKEN: 't', GH_TOKEN: 't', PR_VISUALS_HEADERS: '{}',
    ACTIONS_RUNTIME_TOKEN: 't', ACTIONS_ID_TOKEN_REQUEST_URL: 'u', 'INPUT_GITHUB-TOKEN': 't', GIT_CONFIG_VALUE_0: 'x',
    NPM_TOKEN: 't', MY_SECRET: 's', DISPLAY: ':0' });
  assert.deepEqual(env, { PATH: '/bin', HOME: '/h', DISPLAY: ':0' });
});

test('blocks a same-origin document that redirects to another origin', async () => {
  const blocked = [];
  const handler = makeRouteHandler({ origin: 'https://a.example', onBlocked: (u) => blocked.push(u) });
  const r = fakeRoute('https://a.example/go', { navigation: true });
  r.route.fetch = async (opts) => {
    r.log.push(['fetch', opts]);
    return { status: () => 302, headers: () => ({ location: 'https://evil.example/x' }) };
  };
  await handler(r.route, r.request);
  assert.deepEqual(r.log.map((l) => l[0]), ['fetch', 'abort']);
  assert.deepEqual(blocked, ['https://evil.example/x']);
});
