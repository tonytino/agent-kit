import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_VIEWPORTS, parseConfig, templateUrl, validateConfig } from '../src/config.mjs';

const SHA = '0123456789abcdef0123456789abcdef01234567';

test('accepts a full valid config', () => {
  const c = validateConfig({
    before: { url: 'https://www.example.com' },
    after: { source: 'github-deployment', environment: 'Preview', timeoutMinutes: 10 },
    viewports: { desktop: { width: 1280, height: 800 }, mobile: { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 3 } },
    fullPage: false,
  });
  assert.equal(c.after.source, 'github-deployment');
  assert.equal(c.after.timeoutMinutes, 10);
  assert.equal(c.fullPage, false);
  assert.deepEqual(Object.keys(c.viewports), ['desktop', 'mobile']);
});

test('applies defaults', () => {
  const c = validateConfig({ before: { url: 'https://a.example' }, after: { url: 'https://pr-{number}.example.com' } });
  assert.deepEqual(c.viewports, DEFAULT_VIEWPORTS);
  assert.equal(c.fullPage, true);
  const d = validateConfig({ before: { url: 'https://a.example' }, after: { source: 'github-deployment' } });
  assert.equal(d.after.timeoutMinutes, 15);
  assert.equal(d.after.environment, undefined);
});

test('local mode does not require sources', () => {
  assert.doesNotThrow(() => validateConfig({}, { requireSources: false }));
  assert.throws(() => validateConfig({}), (e) => e.details.includes('"before" is required.'));
});

test('rejects invalid configs with clear errors', () => {
  const cases = [
    [{ before: { url: 'ftp://x' }, after: { url: 'https://a' } }, /before.url/],
    [{ before: { url: 'https://a/{branch}' }, after: { url: 'https://a' } }, /unknown placeholder/],
    [{ before: { url: 'https://user:pw@a' }, after: { url: 'https://a' } }, /credentials/],
    [{ before: { url: 'https://a' }, after: { source: 'vercel' } }, /"after" must be/],
    [{ before: { url: 'https://a' }, after: { url: 'https://a', environment: 'x' } }, /no other keys/],
    [{ before: { url: 'https://a' }, after: { source: 'github-deployment', timeoutMinutes: 0 } }, /timeoutMinutes/],
    [{ before: { url: 'https://a' }, after: { url: 'https://a' }, viewports: { Desktop: { width: 1, height: 1 } } }, /Viewport name/],
    [{ before: { url: 'https://a' }, after: { url: 'https://a' }, viewports: { d: { width: 100, height: 800 } } }, /width/],
    [{ before: { url: 'https://a' }, after: { url: 'https://a' }, viewports: { d: { width: 800, height: 800, zoom: 2 } } }, /unknown key "zoom"/],
    [{ before: { url: 'https://a' }, after: { url: 'https://a' }, fullPage: 'yes' }, /fullPage/],
    [{ before: { url: 'https://a' }, after: { url: 'https://a' }, extra: 1 }, /Unknown key "extra"/],
  ];
  for (const [cfg, re] of cases) {
    assert.throws(() => validateConfig(cfg), (e) => e.details.some((d) => re.test(d)), JSON.stringify(cfg));
  }
  assert.throws(() => parseConfig('{'), /not valid JSON/);
  assert.throws(() => validateConfig([]), /JSON object/);
});

test('templates {number} and {sha}', () => {
  assert.equal(templateUrl('https://pr-{number}.example.com/?v={sha}', { number: 42, sha: SHA }), `https://pr-42.example.com/?v=${SHA}`);
  assert.throws(() => templateUrl('https://x/{number}', { number: 0, sha: SHA }), /positive integer/);
  assert.throws(() => templateUrl('https://x/{sha}', { number: 1, sha: 'abc' }), /40-character/);
});
