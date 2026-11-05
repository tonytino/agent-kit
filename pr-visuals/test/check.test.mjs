import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkVisuals } from '../src/check.mjs';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
const body = (meta) => `Text\n<!-- pr-visuals:start -->\n<!-- pr-visuals:meta ${meta} -->\n## Visuals\n<!-- pr-visuals:end -->\n`;
const good = body(JSON.stringify({ version: 1, sha: A, confirmed: [B] }));

test('visuals:none passes', () => {
  assert.equal(checkVisuals({ labels: ['visuals:none'], body: '', headSha: A }).ok, true);
});

test('no block fails with instructions', () => {
  const r = checkVisuals({ labels: [], body: 'nothing', headSha: A });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'Apply visuals:generate (with a scenarios block) or visuals:none.');
});

test('matching sha passes', () => {
  assert.equal(checkVisuals({ labels: [], body: good, headSha: A }).ok, true);
});

test('confirmed sha passes', () => {
  assert.equal(checkVisuals({ labels: [], body: good, headSha: B }).ok, true);
});

test('stale sha fails with recapture advice', () => {
  const r = checkVisuals({ labels: [], body: good, headSha: C });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'Visuals were captured on aaaaaaa. Apply visuals:generate to recapture, or visuals:still-valid if the new commits do not change the UI.');
});

test('malformed meta is treated as no block', () => {
  for (const meta of ['{not json}', JSON.stringify({ version: 2, sha: A }), JSON.stringify({ version: 1, sha: 'abc' }),
    JSON.stringify({ version: 1, sha: A, confirmed: 'x' })]) {
    const r = checkVisuals({ labels: [], body: body(meta), headSha: A });
    assert.equal(r.ok, false, meta);
    assert.match(r.reason, /^Apply visuals:generate/);
  }
});
