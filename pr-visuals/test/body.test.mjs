import assert from 'node:assert/strict';
import { test } from 'node:test';
import { END, escapeText, findBlock, parseMeta, readMeta, renderBlock, replaceMeta, START, upsertBlock } from '../src/body.mjs';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const manifest = {
  version: 1,
  scenarios: [{
    name: 'Filters <b>|x</b> & "q"', slug: 'filters', video: true,
    cells: [
      { viewport: 'desktop', before: { screenshot: 'filters/desktop-before.png', video: 'filters/desktop-before.webm' },
        after: { screenshot: 'filters/desktop-after.png', video: 'filters/desktop-after.webm' } },
      { viewport: 'mobile', before: { error: 'step click: Timeout 15000ms exceeded.' }, after: { screenshot: 'filters/mobile-after.png' } },
    ],
  }],
};
const block = (sha = A) => renderBlock({ manifest, owner: 'o', repo: 'r', basePath: 'pr-1/aaaaaaa-9', sha });

test('renders the block with meta, table, image URLs, and videos', () => {
  const b = block();
  assert.ok(b.startsWith(`${START}\n<!-- pr-visuals:meta {"version":1,"sha":"${A}","confirmed":[]} -->`));
  assert.ok(b.endsWith(END));
  assert.match(b, /\| Viewport \| Before \| After \|/);
  assert.ok(b.includes('src="https://github.com/o/r/blob/pr-visuals/pr-1/aaaaaaa-9/filters/desktop-before.png?raw=true"'));
  assert.ok(b.includes('[before](https://github.com/o/r/blob/pr-visuals/pr-1/aaaaaaa-9/filters/desktop-before.webm?raw=true)'));
  assert.ok(b.includes('| mobile | Not present before this PR<br><sub>step click: Timeout 15000ms exceeded\\.</sub> | <img'), b);
  assert.ok(!b.includes('capture failed'));
  assert.deepEqual(parseMeta(b), { version: 1, sha: A, confirmed: [] });
});

test('an after-side failure renders as capture failed', () => {
  const m = { version: 1, scenarios: [{ name: 'X', slug: 'x', video: false,
    cells: [{ viewport: 'desktop', before: { screenshot: 'x/desktop-before.png' }, after: { error: 'HTTP 500 at /x <b>' } }] }] };
  const b = renderBlock({ manifest: m, owner: 'o', repo: 'r', basePath: 'p', sha: A });
  assert.ok(b.includes('| capture failed: HTTP 500 at /x &lt;b&gt; |'), b);
});

test('escapes scenario names in headings and attributes', () => {
  const b = block();
  assert.ok(!b.includes('<b>'));
  assert.ok(b.includes('### Filters &lt;b&gt;\\|x&lt;/b&gt; &amp; &quot;q&quot;'));
  assert.ok(b.includes('alt="Filters &lt;b&gt;|x&lt;/b&gt; &amp; &quot;q&quot; desktop before"'));
  assert.equal(escapeText('a\n<!-- pr-visuals:end -->'), 'a &lt;\\!\\-\\- pr\\-visuals:end \\-\\-&gt;');
});

test('rejects unsafe paths in a manifest', () => {
  const bad = { version: 1, scenarios: [{ ...manifest.scenarios[0], cells: [{ viewport: 'd', before: { screenshot: '../x.png' }, after: {} }] }] };
  assert.throws(() => renderBlock({ manifest: bad, owner: 'o', repo: 'r', basePath: 'p', sha: A }), /Invalid file path/);
  assert.throws(() => renderBlock({ manifest, owner: 'o', repo: 'r', basePath: '../p', sha: A }), /Invalid base path/);
  assert.throws(() => renderBlock({ manifest, owner: 'o/x', repo: 'r', basePath: 'p', sha: A }), /Invalid repository/);
});

test('appends the block when absent', () => {
  assert.equal(upsertBlock('Hello', 'BLOCK'), 'Hello\n\nBLOCK\n');
  assert.equal(upsertBlock('Hello\n', 'BLOCK'), 'Hello\n\nBLOCK\n');
  assert.equal(upsertBlock('', 'BLOCK'), 'BLOCK\n');
  assert.equal(upsertBlock(null, 'BLOCK'), 'BLOCK\n');
});

test('replaces the block in place and preserves other text byte-for-byte', () => {
  const before = 'Line 1\r\n  weird   spacing\t\n<!-- pr-visuals:scenarios\n{"scenarios":[]}\n-->\n';
  const after = '\r\n## Notes\nTrailing  \n\n';
  const body = `${before}${block()}${after}`;
  const updated = upsertBlock(body, block(B));
  assert.equal(updated, `${before}${block(B)}${after}`);
  assert.equal(readMeta(updated)?.sha, B);
  const found = findBlock(updated);
  assert.equal(updated.slice(0, found.start), before);
  assert.equal(updated.slice(found.end), after);
});

test('refuses a start marker without an end marker', () => {
  assert.throws(() => upsertBlock(`x\n${START}\nno end`, 'BLOCK'), /without a pr-visuals:end/);
});

test('replaceMeta updates only the meta line', () => {
  const body = `Top $& $1\n${block()}\nBottom`;
  const updated = replaceMeta(body, { version: 1, sha: A, confirmed: [B] });
  assert.deepEqual(readMeta(updated), { version: 1, sha: A, confirmed: [B] });
  assert.equal(updated.replace(/<!-- pr-visuals:meta .* -->/, ''), body.replace(/<!-- pr-visuals:meta .* -->/, ''));
  assert.throws(() => replaceMeta('no block', { version: 1, sha: A, confirmed: [] }), /no valid visuals block/);
});

test('parseMeta rejects malformed meta', () => {
  assert.equal(parseMeta('<!-- pr-visuals:meta {bad} -->'), null);
  assert.equal(parseMeta('<!-- pr-visuals:meta {"version":1,"sha":"ABC"} -->'), null);
  assert.equal(parseMeta('no meta'), null);
  assert.deepEqual(parseMeta(`<!-- pr-visuals:meta {"version":1,"sha":"${A}"} -->`), { version: 1, sha: A, confirmed: [] });
});
