import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { UserError } from './errors.mjs';
import { isPlainObject } from './scenarios.mjs';

/**
 * @typedef {{ width: number, height: number, isMobile?: boolean, hasTouch?: boolean, deviceScaleFactor?: number }} Viewport
 * @typedef {{ url: string }} UrlSource
 * @typedef {{ source: 'github-deployment', environment?: string, timeoutMinutes: number }} DeploymentSource
 * @typedef {{ before?: UrlSource, after?: UrlSource | DeploymentSource, viewports: Record<string, Viewport>, fullPage: boolean }} Config
 */

export const DEFAULT_VIEWPORTS = Object.freeze({
  desktop: { width: 1280, height: 800 },
  mobile: { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 3 },
});

const TOP_KEYS = new Set(['before', 'after', 'viewports', 'fullPage']);
const VIEWPORT_KEYS = new Set(['width', 'height', 'isMobile', 'hasTouch', 'deviceScaleFactor']);
const PLACEHOLDER_RE = /\{([^{}]*)\}/g;

/**
 * Reads and validates a local config file. Symlinks are refused.
 * @param {string} file
 * @param {{ requireSources?: boolean, hasHeaders?: boolean }} [opts]
 * @returns {Promise<Config>}
 */
export async function loadConfig(file, opts) {
  return parseConfig(await readRegularFile(file, 'config'), opts);
}

/**
 * Reads a file as UTF-8 and refuses symlinks and non-regular files.
 * @param {string} file
 * @param {string} what used in error messages
 * @returns {Promise<string>}
 */
export async function readRegularFile(file, what) {
  let handle;
  try {
    // O_NOFOLLOW makes the open fail on a symlink, with no gap between check and read.
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const st = await handle.stat();
    if (!st.isFile()) throw new UserError(`The ${what} ${file} is not a regular file.`);
    return await handle.readFile('utf8');
  } catch (err) {
    if (err instanceof UserError) throw err;
    const code = /** @type {NodeJS.ErrnoException} */ (err).code;
    if (code === 'ELOOP') throw new UserError(`The ${what} ${file} is a symlink. Pass the real file.`);
    throw new UserError(`Cannot read the ${what} ${file}: ${code ?? err}`);
  } finally {
    await handle?.close();
  }
}

/**
 * @param {string} text
 * @param {{ requireSources?: boolean, hasHeaders?: boolean }} [opts]
 * @returns {Config}
 */
export function parseConfig(text, opts) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new UserError(`Config is not valid JSON: ${err instanceof Error ? err.message : err}`);
  }
  return validateConfig(data, opts);
}

/**
 * Validates a config object. With requireSources (the default), `before` and `after` are required.
 * @param {unknown} data
 * With hasHeaders, a github-deployment source must name an environment. Otherwise any deployment
 * for the commit (from any integration) could receive the secret headers.
 * @param {{ requireSources?: boolean, hasHeaders?: boolean }} [opts]
 * @returns {Config}
 */
export function validateConfig(data, { requireSources = true, hasHeaders = false } = {}) {
  /** @type {string[]} */
  const errors = [];
  if (!isPlainObject(data)) throw new UserError('Config must be a JSON object.');
  for (const key of Object.keys(data)) if (!TOP_KEYS.has(key)) errors.push(`Unknown key "${key}".`);

  /** @type {Config} */
  const config = { viewports: { ...DEFAULT_VIEWPORTS }, fullPage: true };

  if (data.before !== undefined) {
    if (!isPlainObject(data.before) || Object.keys(data.before).some((k) => k !== 'url')) {
      errors.push('"before" must be { "url": "https://..." }.');
    } else {
      const e = checkUrlTemplate(data.before.url);
      if (e) errors.push(`before.url ${e}`);
      else config.before = { url: data.before.url };
    }
  } else if (requireSources) {
    errors.push('"before" is required.');
  }

  if (data.after !== undefined) {
    const a = data.after;
    if (!isPlainObject(a)) {
      errors.push('"after" must be an object.');
    } else if ('url' in a) {
      if (Object.keys(a).some((k) => k !== 'url')) errors.push('"after" with "url" must have no other keys.');
      const e = checkUrlTemplate(a.url);
      if (e) errors.push(`after.url ${e}`);
      else config.after = { url: a.url };
    } else if (a.source === 'github-deployment') {
      for (const k of Object.keys(a)) {
        if (!['source', 'environment', 'timeoutMinutes'].includes(k)) errors.push(`after: unknown key "${k}".`);
      }
      if (a.environment !== undefined && (typeof a.environment !== 'string' || !a.environment.trim() || a.environment.length > 255)) {
        errors.push('after.environment must be a non-empty string.');
      }
      const t = a.timeoutMinutes ?? 15;
      if (typeof t !== 'number' || !Number.isFinite(t) || t < 1 || t > 120) errors.push('after.timeoutMinutes must be a number from 1 to 120.');
      if (hasHeaders && a.environment === undefined) {
        errors.push('after.environment is required when PR_VISUALS_HEADERS is set, so the headers go only to that environment.');
      }
      config.after = { source: 'github-deployment', environment: a.environment, timeoutMinutes: t };
    } else {
      errors.push('"after" must be { "url": "..." } or { "source": "github-deployment", ... }.');
    }
  } else if (requireSources) {
    errors.push('"after" is required.');
  }

  if (data.viewports !== undefined) {
    if (!isPlainObject(data.viewports) || Object.keys(data.viewports).length === 0 || Object.keys(data.viewports).length > 10) {
      errors.push('"viewports" must be an object with 1 to 10 entries.');
    } else {
      /** @type {Record<string, Viewport>} */
      const vps = {};
      for (const [name, vp] of Object.entries(data.viewports)) {
        const at = `viewports.${name}`;
        if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(name)) {
          errors.push(`Viewport name "${name}" must use lowercase letters, numbers, and hyphens (max 32).`);
          continue;
        }
        if (!isPlainObject(vp)) {
          errors.push(`${at} must be an object.`);
          continue;
        }
        for (const k of Object.keys(vp)) if (!VIEWPORT_KEYS.has(k)) errors.push(`${at}: unknown key "${k}".`);
        for (const k of ['width', 'height']) {
          if (!Number.isInteger(vp[k]) || vp[k] < 200 || vp[k] > 4000) errors.push(`${at}.${k} must be an integer from 200 to 4000.`);
        }
        for (const k of ['isMobile', 'hasTouch']) {
          if (vp[k] !== undefined && typeof vp[k] !== 'boolean') errors.push(`${at}.${k} must be true or false.`);
        }
        const dsf = vp.deviceScaleFactor;
        if (dsf !== undefined && (typeof dsf !== 'number' || dsf < 1 || dsf > 4)) errors.push(`${at}.deviceScaleFactor must be a number from 1 to 4.`);
        vps[name] = { ...vp };
      }
      config.viewports = vps;
    }
  }

  if (data.fullPage !== undefined) {
    if (typeof data.fullPage !== 'boolean') errors.push('"fullPage" must be true or false.');
    else config.fullPage = data.fullPage;
  }

  if (errors.length) throw new UserError('Invalid pr-visuals config.', { details: errors });
  return config;
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function checkUrlTemplate(value) {
  if (typeof value !== 'string' || !value) return 'must be a URL string.';
  for (const [, name] of value.matchAll(PLACEHOLDER_RE)) {
    if (name !== 'number' && name !== 'sha') return `has unknown placeholder "{${name}}". Use {number} or {sha}.`;
  }
  try {
    assertHttpUrl(fillTemplate(value, { number: 1, sha: '0'.repeat(40) }));
  } catch (err) {
    return `is not a valid http(s) URL: ${err instanceof Error ? err.message : err}`;
  }
  return null;
}

/**
 * Replaces {number} and {sha} in a URL template and validates the result.
 * @param {string} template
 * @param {{ number: number, sha: string }} vars
 * @returns {string}
 */
export function templateUrl(template, vars) {
  if (!Number.isInteger(vars.number) || vars.number < 1) throw new UserError('PR number must be a positive integer.');
  if (!/^[0-9a-f]{40}$/.test(vars.sha)) throw new UserError('Head SHA must be a full 40-character SHA.');
  const url = fillTemplate(template, vars);
  assertHttpUrl(url);
  return url;
}

/**
 * @param {string} template
 * @param {{ number: number, sha: string }} vars
 */
function fillTemplate(template, vars) {
  return template.replace(PLACEHOLDER_RE, (whole, name) => {
    if (name === 'number') return String(vars.number);
    if (name === 'sha') return vars.sha;
    throw new UserError(`Unknown placeholder ${whole}.`);
  });
}

/**
 * @param {string} value
 * @returns {URL}
 */
export function assertHttpUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new UserError(`"${value}" is not a URL.`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new UserError(`"${value}" must use http or https.`);
  if (url.username || url.password) throw new UserError('URLs must not contain credentials. Use PR_VISUALS_HEADERS.');
  return url;
}
