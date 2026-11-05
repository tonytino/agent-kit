import { UserError } from './errors.mjs';

export const SCENARIOS_DOC_URL =
  'https://github.com/tonytino/agent-kit/blob/main/pr-visuals/skills/pr-visuals/references/scenarios.md';

export const LIMITS = Object.freeze({
  scenarios: 10,
  steps: 30,
  nameLength: 100,
  pathLength: 2000,
  selectorLength: 500,
  valueLength: 2000,
  keyLength: 50,
  waitMs: 10000,
  scrollPx: 100000,
});

const OPEN = '<!-- pr-visuals:scenarios';
const CLOSE = '-->';
const STEP_KEYS = new Set(['goto', 'click', 'fill', 'press', 'hover', 'waitFor', 'wait', 'scroll']);
const SCENARIO_KEYS = new Set(['name', 'path', 'viewports', 'video', 'steps']);
// Placeholder origin used to check paths before the real base URL is known.
const PROBE_BASE = 'https://pr-visuals.invalid/';
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

/**
 * @typedef {{ goto: string } | { click: string } | { fill: [string, string] } | { press: string }
 *   | { hover: string } | { waitFor: string } | { wait: number } | { scroll: number }} Step
 * @typedef {{ name: string, path: string, viewports: string[], video: boolean, steps: Step[] }} Scenario
 */

/**
 * Extracts the raw JSON text of the scenarios block from a PR body.
 * @param {string | null | undefined} body
 * @returns {string | null} null when the block is absent
 */
export function extractScenariosText(body) {
  if (!body) return null;
  const first = body.indexOf(OPEN);
  if (first === -1) return null;
  if (body.indexOf(OPEN, first + OPEN.length) !== -1) {
    throw new UserError('The PR description has more than one pr-visuals:scenarios block. Keep exactly one.');
  }
  const start = first + OPEN.length;
  const end = body.indexOf(CLOSE, start);
  if (end === -1) throw new UserError('The pr-visuals:scenarios block is not closed with -->.');
  return body.slice(start, end);
}

/**
 * Parses and validates the scenarios block in a PR body.
 * @param {string | null | undefined} body
 * @param {string[]} viewportNames viewports defined in the config
 * @returns {Scenario[]}
 */
export function parseScenariosFromBody(body, viewportNames) {
  const text = extractScenariosText(body);
  if (text === null || text.trim() === '') {
    throw new UserError('The PR description has no pr-visuals:scenarios block, or the block is empty.');
  }
  return parseScenariosJson(text, viewportNames);
}

/**
 * @param {string} text JSON text
 * @param {string[]} viewportNames
 * @returns {Scenario[]}
 */
export function parseScenariosJson(text, viewportNames) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new UserError(`The scenarios block is not valid JSON: ${err instanceof Error ? err.message : err}`);
  }
  return validateScenarios(data, viewportNames);
}

/**
 * @param {unknown} data
 * @param {string[]} viewportNames
 * @returns {Scenario[]}
 */
export function validateScenarios(data, viewportNames) {
  /** @type {string[]} */
  const errors = [];
  if (!isPlainObject(data)) throw new UserError('The scenarios block must be a JSON object with a "scenarios" array.');
  for (const key of Object.keys(data)) {
    if (key !== 'scenarios') errors.push(`Unknown top-level key "${key}".`);
  }
  const list = data.scenarios;
  if (!Array.isArray(list)) {
    throw new UserError('Invalid scenarios block.', { details: ['"scenarios" must be an array.', ...errors] });
  }
  if (list.length < 1 || list.length > LIMITS.scenarios) {
    errors.push(`"scenarios" must have 1 to ${LIMITS.scenarios} entries (found ${list.length}).`);
  }
  const names = new Set();
  /** @type {Scenario[]} */
  const out = [];
  list.slice(0, LIMITS.scenarios).forEach((raw, i) => {
    const at = `scenarios[${i}]`;
    if (!isPlainObject(raw)) {
      errors.push(`${at} must be an object.`);
      return;
    }
    for (const key of Object.keys(raw)) {
      if (!SCENARIO_KEYS.has(key)) errors.push(`${at}: unknown key "${key}".`);
    }
    const { name, path, viewports, video, steps } = raw;
    if (typeof name !== 'string' || !name.trim() || name.length > LIMITS.nameLength || CONTROL.test(name)) {
      errors.push(`${at}.name must be a non-empty string of at most ${LIMITS.nameLength} characters without control characters.`);
    } else if (names.has(name)) {
      errors.push(`${at}.name "${name}" is not unique.`);
    } else {
      names.add(name);
    }
    const pathError = checkPath(path);
    if (pathError) errors.push(`${at}.path ${pathError}`);

    let vps = viewportNames;
    if (viewports !== undefined) {
      if (!Array.isArray(viewports) || viewports.length === 0 || !viewports.every((v) => typeof v === 'string')) {
        errors.push(`${at}.viewports must be a non-empty array of viewport names.`);
      } else {
        const unknown = viewports.filter((v) => !viewportNames.includes(v));
        if (unknown.length) errors.push(`${at}.viewports has unknown names: ${unknown.join(', ')}. Known: ${viewportNames.join(', ')}.`);
        if (new Set(viewports).size !== viewports.length) errors.push(`${at}.viewports has duplicates.`);
        vps = viewports;
      }
    }
    if (video !== undefined && typeof video !== 'boolean') errors.push(`${at}.video must be true or false.`);

    /** @type {Step[]} */
    const parsedSteps = [];
    if (steps !== undefined) {
      if (!Array.isArray(steps)) {
        errors.push(`${at}.steps must be an array.`);
      } else {
        if (steps.length > LIMITS.steps) errors.push(`${at}.steps has ${steps.length} steps; the limit is ${LIMITS.steps}.`);
        steps.slice(0, LIMITS.steps).forEach((step, j) => {
          const stepError = checkStep(step);
          if (stepError) errors.push(`${at}.steps[${j}] ${stepError}`);
          else parsedSteps.push(/** @type {Step} */ (step));
        });
      }
    }
    out.push({
      name: /** @type {string} */ (name),
      path: /** @type {string} */ (path),
      viewports: [...vps],
      video: video === true,
      steps: parsedSteps,
    });
  });
  if (errors.length) throw new UserError('Invalid scenarios block.', { details: errors });
  return out;
}

/**
 * Returns an error string, or null when the path is a safe same-origin relative path.
 * @param {unknown} path
 * @returns {string | null}
 */
export function checkPath(path) {
  if (typeof path !== 'string' || path.length === 0) return 'must be a string starting with "/".';
  if (path.length > LIMITS.pathLength) return `must be at most ${LIMITS.pathLength} characters.`;
  if (!path.startsWith('/')) return 'must start with "/".';
  if (path.startsWith('//')) return 'must not start with "//".';
  // The URL parser treats "\" as "/" and strips tabs and newlines, so "/\host" and "/\t/host" become "//host".
  if (path.includes('\\')) return 'must not contain "\\".';
  if (CONTROL.test(path) || /\s/.test(path)) return 'must not contain whitespace or control characters.';
  try {
    if (new URL(path, PROBE_BASE).origin !== new URL(PROBE_BASE).origin) return 'must stay on the same origin.';
  } catch {
    return 'is not a valid URL path.';
  }
  return null;
}

/**
 * Resolves a scenario path against a base URL and asserts the origin did not change.
 * @param {string} base
 * @param {string} path
 * @returns {string}
 */
export function resolveSafeUrl(base, path) {
  const pathError = checkPath(path);
  if (pathError) throw new UserError(`Path "${path}" ${pathError}`);
  const baseUrl = new URL(base);
  const url = new URL(path, baseUrl);
  if (url.origin !== baseUrl.origin) throw new UserError(`Path "${path}" leaves the origin ${baseUrl.origin}.`);
  return url.href;
}

/**
 * @param {unknown} step
 * @returns {string | null}
 */
function checkStep(step) {
  if (!isPlainObject(step)) return 'must be an object with exactly one key.';
  const keys = Object.keys(step);
  if (keys.length !== 1) return `must have exactly one key (found ${keys.length}).`;
  const key = keys[0];
  if (!STEP_KEYS.has(key)) return `has unknown key "${key}". Allowed: ${[...STEP_KEYS].join(', ')}.`;
  const value = step[key];
  switch (key) {
    case 'goto': {
      const e = checkPath(value);
      return e ? `goto ${e}` : null;
    }
    case 'click':
    case 'hover':
    case 'waitFor':
      return checkSelector(value) ? `${key} ${checkSelector(value)}` : null;
    case 'fill': {
      if (!Array.isArray(value) || value.length !== 2) return 'fill must be [selector, value].';
      const e = checkSelector(value[0]);
      if (e) return `fill selector ${e}`;
      if (typeof value[1] !== 'string' || value[1].length > LIMITS.valueLength) {
        return `fill value must be a string of at most ${LIMITS.valueLength} characters.`;
      }
      return null;
    }
    case 'press':
      if (typeof value !== 'string' || !value || value.length > LIMITS.keyLength || CONTROL.test(value)) {
        return `press must be a key name of at most ${LIMITS.keyLength} characters, like "Enter".`;
      }
      return null;
    case 'wait':
      if (!Number.isInteger(value) || value < 0 || value > LIMITS.waitMs) return `wait must be an integer from 0 to ${LIMITS.waitMs} (ms).`;
      return null;
    case 'scroll':
      if (!Number.isInteger(value) || Math.abs(value) > LIMITS.scrollPx) return `scroll must be an integer from -${LIMITS.scrollPx} to ${LIMITS.scrollPx} (pixels).`;
      return null;
    default:
      return 'is not supported.';
  }
}

/** @param {unknown} sel */
function checkSelector(sel) {
  if (typeof sel !== 'string' || !sel.trim() || sel.length > LIMITS.selectorLength || CONTROL.test(sel)) {
    return `must be a selector string of at most ${LIMITS.selectorLength} characters.`;
  }
  return null;
}

/**
 * @param {unknown} v
 * @returns {v is Record<string, any>}
 */
export function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
