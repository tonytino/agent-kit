import assert from 'node:assert/strict';
import { test } from 'node:test';
import { botMarkers, checkVisuals, latestCaptured, renderResultMarker } from '../src/check.mjs';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
const body = (meta) => `Text\n<!-- pr-visuals:start -->\n<!-- pr-visuals:meta ${meta} -->\n## Visuals\n<!-- pr-visuals:end -->\n`;
const good = body(JSON.stringify({ version: 1, sha: A, confirmed: [B] }));
const bot = (text) => ({ user: { login: 'github-actions[bot]', type: 'Bot' }, body: text });
const captured = (sha, failed = 0) => bot(`Captured.\n${renderResultMarker({ kind: 'captured', sha, failed })}`);
const stillValid = (sha) => bot(`Marked.\n${renderResultMarker({ kind: 'still-valid', sha })}`);
const run = (comments, headSha, opts = {}) =>
  checkVisuals({ labels: opts.labels ?? [], body: opts.body ?? good, headSha, markers: botMarkers(comments) });

test('visuals:none passes', () => {
  assert.equal(checkVisuals({ labels: ['visuals:none'], body: '', headSha: A, markers: [] }).ok, true);
});

test('no bot marker fails with instructions', () => {
  const r = run([], A);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'Apply visuals:generate (with a scenarios block) or visuals:none.');
});

test('forged body meta without a bot comment fails', () => {
  assert.equal(run([], A, { body: good }).ok, false);
});

test('bot captured marker for the head passes', () => {
  assert.equal(run([captured(A)], A).ok, true);
});

test('bot still-valid marker for the head passes', () => {
  assert.equal(run([captured(A), stillValid(B)], B).ok, true);
});

test('markers by a non-bot user are ignored', () => {
  const forged = { user: { login: 'mallory', type: 'User' }, body: renderResultMarker({ kind: 'captured', sha: A, failed: 0 }) };
  assert.equal(run([forged], A).ok, false);
  const fakeBotName = { user: { login: 'github-actions[bot]', type: 'User' }, body: forged.body };
  assert.equal(run([fakeBotName], A).ok, false);
  const otherBot = { user: { login: 'other[bot]', type: 'Bot' }, body: forged.body };
  assert.equal(run([otherBot], A).ok, false);
  assert.equal(botMarkers([otherBot], 'other[bot]').length, 1);
});

test('stale capture fails with recapture advice', () => {
  const r = run([captured(A)], C);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'Visuals were captured on aaaaaaa. Apply visuals:generate to recapture, or visuals:still-valid if the new commits do not change the UI.');
});

test('failed captures fail the check', () => {
  const r = run([captured(A, 2)], A);
  assert.equal(r.ok, false);
  assert.equal(r.reason, '2 captures failed. Fix the scenario steps and apply visuals:generate.');
  assert.equal(run([captured(A, 2), captured(A, 0)], A).ok, true);
});

test('a missing body block fails even with a bot marker', () => {
  const r = run([captured(A)], A, { body: 'deleted' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /missing from the PR description/);
});

test('malformed markers are ignored', () => {
  const bad = [bot('<!-- pr-visuals:result {bad} -->'), bot(`<!-- pr-visuals:result {"kind":"captured","sha":"${A}"} -->`),
    bot('<!-- pr-visuals:result {"kind":"captured","sha":"abc","failed":0} -->')];
  assert.deepEqual(botMarkers(bad), []);
  assert.equal(latestCaptured(botMarkers([captured(A, 1), stillValid(B), captured(C, 0)]))?.sha, C);
});
