import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkPath, parseScenariosFromBody, parseScenariosJson, resolveSafeUrl } from '../src/scenarios.mjs';

const VPS = ['desktop', 'mobile'];
const block = (json) => `Intro text\n\n<!-- pr-visuals:scenarios\n${json}\n-->\n\nMore text`;
const one = (extra = {}) => JSON.stringify({ scenarios: [{ name: 'Home', path: '/', ...extra }] });

test('parses a valid block and applies defaults', () => {
  const body = block(JSON.stringify({
    scenarios: [{
      name: 'Directory filters', path: '/?sort=near', viewports: ['mobile'], video: true,
      steps: [{ click: 'role=button[name="Filters"]' }, { fill: ['#q', 'pizza'] }, { press: 'Enter' },
        { waitFor: 'text=Results' }, { wait: 500 }, { hover: '#x' }, { scroll: 400 }, { goto: '/about' }],
    }, { name: 'Home', path: '/' }],
  }));
  const s = parseScenariosFromBody(body, VPS);
  assert.equal(s.length, 2);
  assert.deepEqual(s[0].viewports, ['mobile']);
  assert.equal(s[0].video, true);
  assert.equal(s[0].steps.length, 8);
  assert.deepEqual(s[1].viewports, VPS);
  assert.equal(s[1].video, false);
  assert.deepEqual(s[1].steps, []);
});

test('missing block fails', () => {
  assert.throws(() => parseScenariosFromBody('just text', VPS), /no pr-visuals:scenarios block/);
  assert.throws(() => parseScenariosFromBody(null, VPS), /no pr-visuals:scenarios block/);
});

test('empty block fails', () => {
  assert.throws(() => parseScenariosFromBody('<!-- pr-visuals:scenarios\n\n-->', VPS), /empty/);
});

test('unclosed and duplicate blocks fail', () => {
  assert.throws(() => parseScenariosFromBody('<!-- pr-visuals:scenarios {"scenarios":[]}', VPS), /not closed/);
  assert.throws(() => parseScenariosFromBody(block(one()) + block(one()), VPS), /more than one/);
});

test('bad JSON fails', () => {
  assert.throws(() => parseScenariosFromBody(block('{ scenarios: [ }'), VPS), /not valid JSON/);
});

test('unknown step key fails', () => {
  assert.throws(() => parseScenariosJson(one({ steps: [{ evaluate: 'alert(1)' }] }), VPS), (err) =>
    err.details.some((d) => d.includes('unknown key "evaluate"')));
});

test('step with two keys fails', () => {
  assert.throws(() => parseScenariosJson(one({ steps: [{ click: 'a', hover: 'b' }] }), VPS), (err) =>
    err.details.some((d) => d.includes('exactly one key')));
});

test('bad step values fail', () => {
  for (const step of [{ wait: 10001 }, { wait: -1 }, { wait: 1.5 }, { fill: ['#q'] }, { fill: ['#q', 3] },
    { click: '' }, { press: 'a\nb' }, { scroll: 'down' }, { goto: 'https://evil.example' }]) {
    assert.throws(() => parseScenariosJson(one({ steps: [step] }), VPS), /Invalid scenarios/, JSON.stringify(step));
  }
});

test('absolute, protocol-relative, and scheme paths are rejected', () => {
  for (const p of ['https://evil.example/', '//evil.example/x', 'javascript:alert(1)', 'evil', '/\\evil.example',
    '/\t/evil.example', '/a b', '', 'data:text/html,hi']) {
    assert.ok(checkPath(p), `expected rejection for ${JSON.stringify(p)}`);
    assert.throws(() => parseScenariosJson(one({ path: p }), VPS), /Invalid scenarios/);
  }
  assert.equal(checkPath('/a/b?c=d#e'), null);
});

test('resolveSafeUrl keeps the base origin', () => {
  assert.equal(resolveSafeUrl('https://pr-1.example.com/app/', '/x?y=1'), 'https://pr-1.example.com/x?y=1');
  assert.throws(() => resolveSafeUrl('https://a.example', '//b.example'), /must not start/);
});

test('limits are enforced', () => {
  const many = Array.from({ length: 11 }, (_, i) => ({ name: `s${i}`, path: '/' }));
  assert.throws(() => parseScenariosJson(JSON.stringify({ scenarios: many }), VPS), (e) => e.details.some((d) => d.includes('1 to 10')));
  assert.throws(() => parseScenariosJson(JSON.stringify({ scenarios: [] }), VPS), /Invalid/);
  const steps = Array.from({ length: 31 }, () => ({ wait: 1 }));
  assert.throws(() => parseScenariosJson(one({ steps }), VPS), (e) => e.details.some((d) => d.includes('limit is 30')));
  assert.throws(() => parseScenariosJson(one({ name: 'x'.repeat(101) }), VPS), /Invalid/);
});

test('duplicate names fail', () => {
  const json = JSON.stringify({ scenarios: [{ name: 'A', path: '/' }, { name: 'A', path: '/b' }] });
  assert.throws(() => parseScenariosJson(json, VPS), (e) => e.details.some((d) => d.includes('not unique')));
});

test('unknown viewport and unknown scenario keys fail', () => {
  assert.throws(() => parseScenariosJson(one({ viewports: ['tablet'] }), VPS), (e) => e.details.some((d) => d.includes('tablet')));
  assert.throws(() => parseScenariosJson(one({ script: 'x' }), VPS), (e) => e.details.some((d) => d.includes('"script"')));
  assert.throws(() => parseScenariosJson(one({ video: 'yes' }), VPS), /Invalid/);
  assert.throws(() => parseScenariosJson('{"scenarios":[],"extra":1}', VPS), /Invalid/);
});

test('scroll must be an integer within the stated limit', () => {
  assert.doesNotThrow(() => parseScenariosJson(one({ steps: [{ scroll: -100000 }] }), VPS));
  for (const scroll of [1.5, 100001, '10']) {
    assert.throws(() => parseScenariosJson(one({ steps: [{ scroll }] }), VPS),
      (e) => e.details.some((d) => d.includes('scroll must be an integer from -100000 to 100000 (pixels)')));
  }
});
