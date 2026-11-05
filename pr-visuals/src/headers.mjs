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
 * Builds a Playwright route handler for one side (before or after).
 *
 * - Adds the extra headers only to requests on `origin`. route.continue({ headers }) carries
 *   headers through every redirect hop, including cross-origin hops, so same-origin requests go
 *   through route.fetch with redirects off. A 3xx response is fulfilled as is, and the browser
 *   follows it without the extra headers.
 * - Aborts main-frame navigations to any other origin and reports them through onBlocked.
 *   Main-frame documents on `origin` are fetched with redirects off, so a server redirect to
 *   another origin is blocked before the browser follows it. A same-origin redirect is followed
 *   by the browser without interception; the capture checks the final page origin after each step.
 *
 * @param {{ origin: string, headers?: Record<string, string>, onBlocked?: (url: string) => void }} opts
 * @returns {(route: any, request: any) => Promise<void>}
 */
export function makeRouteHandler({ origin, headers = {}, onBlocked = () => {} }) {
  const allowed = new URL(origin).origin;
  const withHeaders = Object.keys(headers).length > 0;
  return async (route, request) => {
    let requestOrigin;
    try {
      requestOrigin = new URL(request.url()).origin;
    } catch {
      requestOrigin = null;
    }
    if (requestOrigin !== allowed) {
      if (request.isNavigationRequest() && isMainFrame(request)) {
        onBlocked(request.url());
        await route.abort('blockedbyclient');
        return;
      }
      await route.continue();
      return;
    }
    const mainNav = request.isNavigationRequest() && isMainFrame(request);
    if (!withHeaders && !mainNav) {
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
    if (mainNav && response.status() >= 300 && response.status() < 400) {
      const location = response.headers().location;
      let target = null;
      try {
        target = location ? new URL(location, request.url()) : null;
      } catch {
        target = null;
      }
      if (target && target.origin !== allowed) {
        onBlocked(target.href);
        await route.abort('blockedbyclient');
        return;
      }
    }
    await route.fulfill({ response });
  };
}

/** @param {any} request */
function isMainFrame(request) {
  try {
    return request.frame().parentFrame() === null;
  } catch {
    // Service worker requests have no frame.
    return false;
  }
}

const SECRET_ENV_RE = /^(GITHUB_TOKEN|GH_TOKEN|PR_VISUALS_HEADERS)$|^(ACTIONS_|INPUT_|GIT_CONFIG_)|TOKEN|SECRET|PASSWORD|CREDENTIAL|PRIVATE_KEY|API_KEY/i;

/**
 * Copies the environment for the browser process without tokens, secrets, or runner internals.
 * @param {NodeJS.ProcessEnv} env
 * @returns {Record<string, string>}
 */
export function browserEnv(env) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && !SECRET_ENV_RE.test(k)) out[k] = v;
  return out;
}
