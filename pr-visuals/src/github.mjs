import { UserError } from './errors.mjs';

/**
 * @typedef {(method: string, path: string, opts?: { query?: Record<string, string | number | undefined>, body?: unknown, allow404?: boolean }) => Promise<any>} Request
 * @typedef {{ request: Request, paginate: (path: string, query?: Record<string, string | number | undefined>, maxPages?: number) => Promise<any[]> }} GitHub
 */

const MAX_RETRIES = 3;
const IDEMPOTENT = new Set(['GET', 'HEAD', 'PUT', 'PATCH', 'DELETE']);

/** @param {number} ms */
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Minimal GitHub REST client on global fetch.
 * Retries 5xx and rate limit responses. Error messages never contain the token.
 * @param {{ token: string, apiUrl?: string, fetchImpl?: typeof fetch, sleepImpl?: (ms: number) => Promise<void> }} opts
 * @returns {GitHub}
 */
export function createGitHub({ token, apiUrl = 'https://api.github.com', fetchImpl = fetch, sleepImpl = sleep }) {
  if (!token) throw new UserError('GITHUB_TOKEN is not set.');
  const root = apiUrl.replace(/\/+$/, '');

  /** @type {Request} */
  async function request(method, path, { query, body, allow404 = false } = {}) {
    // A POST that failed with 5xx or a dropped connection may have been applied. Retrying it
    // could post a duplicate comment, so POST retries only on rate limit rejections.
    const idempotent = IDEMPOTENT.has(method);
    const url = new URL(root + path);
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
    for (let attempt = 0; ; attempt++) {
      /** @type {Response} */
      let res;
      try {
        res = await fetchImpl(url, {
          method,
          headers: {
            accept: 'application/vnd.github+json',
            authorization: `Bearer ${token}`,
            'x-github-api-version': '2022-11-28',
            'user-agent': 'pr-visuals',
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch (err) {
        if (idempotent && attempt < MAX_RETRIES) {
          await sleepImpl(1000 * 2 ** attempt);
          continue;
        }
        throw new UserError(`GitHub API ${method} ${path} failed: ${err instanceof Error ? err.message : err}`);
      }
      if (res.ok) {
        if (res.status === 204) return null;
        const text = await res.text();
        return text ? JSON.parse(text) : null;
      }
      const text = await res.text().catch(() => '');
      const apiMessage = safeMessage(text);
      const retryAfter = Number(res.headers.get('retry-after'));
      const rateLimited =
        res.status === 429 ||
        (res.status === 403 && (res.headers.get('x-ratelimit-remaining') === '0' || /rate limit/i.test(apiMessage)));
      if (((idempotent && res.status >= 500) || rateLimited) && attempt < MAX_RETRIES) {
        const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 60) * 1000 : 1000 * 2 ** (attempt + 1);
        await sleepImpl(wait);
        continue;
      }
      if (res.status === 404 && allow404) return null;
      const where = `GitHub API ${method} ${path} returned ${res.status}`;
      if (res.status === 401) throw new UserError(`${where}: the token is missing, expired, or invalid.`);
      if (res.status === 403) {
        throw new UserError(`${where}: forbidden (${apiMessage}). Check the workflow "permissions". Fork PRs get a read-only token.`);
      }
      if (res.status === 404) throw new UserError(`${where}: not found, or the token cannot see it.`);
      throw new UserError(`${where}: ${apiMessage}`);
    }
  }
  /**
   * Fetches every page of a list endpoint.
   * @param {string} path
   * @param {Record<string, string | number | undefined>} [query]
   * @param {number} [maxPages]
   * @returns {Promise<any[]>}
   */
  async function paginate(path, query = {}, maxPages = 50) {
    const out = [];
    for (let page = 1; page <= maxPages; page++) {
      const items = (await request('GET', path, { query: { ...query, per_page: 100, page } })) ?? [];
      out.push(...items);
      if (items.length < 100) break;
    }
    return out;
  }
  return { request, paginate };
}

/** @param {string} text */
function safeMessage(text) {
  try {
    const m = JSON.parse(text)?.message;
    if (typeof m === 'string') return m.slice(0, 200);
  } catch {
    // not JSON
  }
  return text.slice(0, 200) || 'no message';
}
