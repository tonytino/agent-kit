import { UserError } from './errors.mjs';
import { isPlainObject } from './scenarios.mjs';

const NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,100}$/;

/**
 * Parses PR_VISUALS_HEADERS. Error messages name the header but never the value.
 * @param {string | undefined} raw
 * @returns {Record<string, string>}
 */
export function parseHeadersEnv(raw) {
  if (!raw || !raw.trim()) return {};
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new UserError('PR_VISUALS_HEADERS is not valid JSON. It must be an object of header names to string values.');
  }
  if (!isPlainObject(data)) throw new UserError('PR_VISUALS_HEADERS must be a JSON object.');
  /** @type {Record<string, string>} */
  const out = {};
  for (const [name, value] of Object.entries(data)) {
    if (!NAME_RE.test(name)) throw new UserError(`PR_VISUALS_HEADERS has an invalid header name "${name.slice(0, 100)}".`);
    if (typeof value !== 'string' || /[\r\n\0]/.test(value)) {
      throw new UserError(`PR_VISUALS_HEADERS value for "${name}" must be a single-line string.`);
    }
    out[name.toLowerCase()] = value;
  }
  return out;
}

/**
 * Builds a Playwright route handler that adds headers only to requests on one origin.
 *
 * route.continue({ headers }) carries the headers through every redirect hop, including
 * cross-origin hops, so same-origin requests go through route.fetch with redirects off.
 * A 3xx response is fulfilled as is, and the browser follows it without the extra headers.
 *
 * @param {string} origin e.g. "https://pr-12.example.com"
 * @param {Record<string, string>} headers
 * @returns {(route: any, request: any) => Promise<void>}
 */
export function makeHeaderRouteHandler(origin, headers) {
  const allowed = new URL(origin).origin;
  return async (route, request) => {
    let requestOrigin;
    try {
      requestOrigin = new URL(request.url()).origin;
    } catch {
      requestOrigin = null;
    }
    if (requestOrigin !== allowed) {
      await route.continue();
      return;
    }
    let response;
    try {
      response = await route.fetch({ headers: { ...request.headers(), ...headers }, maxRedirects: 0 });
    } catch {
      await route.abort('failed').catch(() => {});
      return;
    }
    await route.fulfill({ response });
  };
}
