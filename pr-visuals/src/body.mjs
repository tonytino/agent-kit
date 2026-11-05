import { UserError } from './errors.mjs';

export const START = '<!-- pr-visuals:start -->';
export const END = '<!-- pr-visuals:end -->';
const META_RE = /<!-- pr-visuals:meta (\{.*?\}) -->/;
const SHA_RE = /^[0-9a-f]{40}$/;
// Keeps the meta comment bounded when a PR collects many confirmations.
const MAX_CONFIRMED = 50;

/**
 * @typedef {{ version: 1, sha: string, confirmed: string[] }} Meta
 * @typedef {{ start: number, end: number, content: string }} Block
 */

/**
 * Locates the visuals block. `end` is the index just past the end marker.
 * @param {string | null | undefined} body
 * @returns {Block | null}
 */
export function findBlock(body) {
  if (!body) return null;
  const start = body.indexOf(START);
  if (start === -1) return null;
  const endMarker = body.indexOf(END, start + START.length);
  if (endMarker === -1) return null;
  const end = endMarker + END.length;
  return { start, end, content: body.slice(start, end) };
}

/**
 * Parses the meta comment inside a visuals block. Returns null when it is missing or malformed.
 * @param {string} blockContent
 * @returns {Meta | null}
 */
export function parseMeta(blockContent) {
  const m = META_RE.exec(blockContent);
  if (!m) return null;
  let data;
  try {
    data = JSON.parse(m[1]);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object' || data.version !== 1) return null;
  if (typeof data.sha !== 'string' || !SHA_RE.test(data.sha)) return null;
  const confirmed = data.confirmed ?? [];
  if (!Array.isArray(confirmed) || !confirmed.every((s) => typeof s === 'string' && SHA_RE.test(s))) return null;
  return { version: 1, sha: data.sha, confirmed };
}

/**
 * Reads the meta of the visuals block in a body.
 * @param {string | null | undefined} body
 * @returns {Meta | null}
 */
export function readMeta(body) {
  const block = findBlock(body);
  return block ? parseMeta(block.content) : null;
}

/**
 * @param {Meta} meta
 * @returns {string}
 */
export function renderMeta(meta) {
  assertSha(meta.sha);
  meta.confirmed.forEach(assertSha);
  const confirmed = [...new Set(meta.confirmed)].slice(-MAX_CONFIRMED);
  return `<!-- pr-visuals:meta ${JSON.stringify({ version: 1, sha: meta.sha, confirmed })} -->`;
}

/**
 * Inserts the block at the end of the body, or replaces the existing block in place.
 * Text outside the block is preserved byte-for-byte.
 * @param {string | null | undefined} body
 * @param {string} block full block text, including both markers
 * @returns {string}
 */
export function upsertBlock(body, block) {
  const text = body ?? '';
  const existing = findBlock(text);
  if (existing) return text.slice(0, existing.start) + block + text.slice(existing.end);
  if (text.includes(START)) {
    throw new UserError('The PR description has a pr-visuals:start marker without a pr-visuals:end marker. Fix or remove it.');
  }
  if (text === '') return `${block}\n`;
  const sep = text.endsWith('\n\n') ? '' : text.endsWith('\n') ? '\n' : '\n\n';
  return `${text}${sep}${block}\n`;
}

/**
 * Replaces the meta comment of an existing block. Throws when there is no valid block.
 * @param {string} body
 * @param {Meta} meta
 * @returns {string}
 */
export function replaceMeta(body, meta) {
  const block = findBlock(body);
  if (!block || !parseMeta(block.content)) throw new UserError('The PR description has no valid visuals block.');
  const content = block.content.replace(META_RE, () => renderMeta(meta));
  return body.slice(0, block.start) + content + body.slice(block.end);
}

/**
 * Escapes text for use in GitHub markdown and inline HTML.
 * @param {string} text
 * @returns {string}
 */
export function escapeText(text) {
  // Markdown first: the HTML entities below contain "#", which must stay unescaped.
  const md = String(text).replace(/[\r\n\t]+/g, ' ').replace(/([\\`*_{}[\]()#+\-.!|~])/g, '\\$1');
  return escapeAttr(md);
}

/**
 * Escapes text for an HTML attribute value in double quotes.
 * @param {string} text
 */
export function escapeAttr(text) {
  return String(text)
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** @param {string} sha */
export function assertSha(sha) {
  if (typeof sha !== 'string' || !SHA_RE.test(sha)) throw new UserError(`Invalid commit SHA "${sha}". Use the full 40-character SHA.`);
}

/**
 * @typedef {{ screenshot?: string, video?: string, error?: string }} Side
 * @typedef {{ viewport: string, before: Side, after: Side }} Cell
 * @typedef {{ name: string, slug: string, video: boolean, cells: Cell[] }} ManifestScenario
 * @typedef {{ version: 1, scenarios: ManifestScenario[] }} Manifest
 */

/**
 * Renders the visuals block from a capture manifest.
 * @param {{ manifest: Manifest, owner: string, repo: string, basePath: string, sha: string, confirmed?: string[] }} opts
 * @returns {string}
 */
export function renderBlock({ manifest, owner, repo, basePath, sha, confirmed = [] }) {
  assertRepo(owner, repo);
  const base = assertBasePath(basePath);
  /** @param {string} file */
  const url = (file) => {
    const segs = file.split('/');
    if (segs.some((s) => !/^[A-Za-z0-9._-]+$/.test(s) || s === '.' || s === '..')) {
      throw new UserError(`Invalid file path in manifest: "${file}".`);
    }
    return `https://github.com/${owner}/${repo}/blob/pr-visuals/${base}/${segs.join('/')}?raw=true`;
  };
  const lines = [START, renderMeta({ version: 1, sha, confirmed }), '## Visuals', ''];
  for (const sc of manifest.scenarios) {
    lines.push(`### ${escapeText(sc.name)}`, '', '| Viewport | Before | After |', '| --- | --- | --- |');
    /** @param {Side} side @param {string} label @param {string} vp */
    const cell = (side, label, vp) => {
      if (side.error) return `capture failed: ${escapeText(side.error)}`;
      if (!side.screenshot) return 'capture failed: no screenshot';
      return `<img src="${escapeAttr(url(side.screenshot))}" alt="${escapeAttr(`${sc.name} ${vp} ${label}`)}" width="400">`;
    };
    for (const c of sc.cells) {
      lines.push(`| ${escapeText(c.viewport)} | ${cell(c.before, 'before', c.viewport)} | ${cell(c.after, 'after', c.viewport)} |`);
    }
    if (sc.video) {
      lines.push('');
      for (const c of sc.cells) {
        const b = c.before.video ? `[before](${url(c.before.video)})` : 'before: none';
        const a = c.after.video ? `[after](${url(c.after.video)})` : 'after: none';
        lines.push(`Video (${escapeText(c.viewport)}): ${b} · ${a}  `);
      }
    }
    lines.push('');
  }
  lines.push(END);
  return lines.join('\n');
}

/**
 * @param {string} owner
 * @param {string} repo
 */
export function assertRepo(owner, repo) {
  if (!/^[A-Za-z0-9-]{1,39}$/.test(owner ?? '') || !/^[A-Za-z0-9._-]{1,100}$/.test(repo ?? '') || repo === '.' || repo === '..') {
    throw new UserError(`Invalid repository "${owner}/${repo}". Use owner/repo.`);
  }
}

/**
 * @param {string} basePath like "pr-12/abc1234-987"
 * @returns {string}
 */
export function assertBasePath(basePath) {
  const p = String(basePath ?? '').replace(/^\/+|\/+$/g, '');
  const segs = p.split('/');
  if (!p || segs.some((s) => !/^[A-Za-z0-9._-]+$/.test(s) || s === '.' || s === '..')) {
    throw new UserError(`Invalid base path "${basePath}".`);
  }
  return p;
}
