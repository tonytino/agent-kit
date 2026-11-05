import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { shortReason, UserError } from './errors.mjs';
import { browserEnv, makeRouteHandler } from './headers.mjs';
import { resolveSafeUrl } from './scenarios.mjs';

const STEP_TIMEOUT_MS = 15000;
const NAV_TIMEOUT_MS = 30000;
const IDLE_TIMEOUT_MS = 10000;

/**
 * @typedef {import('./scenarios.mjs').Scenario} Scenario
 * @typedef {import('./config.mjs').Viewport} Viewport
 * @typedef {import('./body.mjs').Manifest} Manifest
 * @typedef {import('./body.mjs').Side} Side
 */

/**
 * Turns a scenario name into a unique directory name.
 * @param {string} name
 * @param {Set<string>} used
 */
export function slugify(name, used) {
  const base = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'scenario';
  let slug = base;
  for (let i = 2; used.has(slug); i++) slug = `${base}-${i}`;
  used.add(slug);
  return slug;
}

/**
 * Launches Chromium. PR_VISUALS_CHROMIUM_PATH overrides the browser binary.
 * @returns {Promise<import('playwright').Browser>}
 */
export async function launchChromium() {
  const { chromium } = await import('playwright');
  const executablePath = process.env.PR_VISUALS_CHROMIUM_PATH || undefined;
  return chromium.launch({ executablePath, env: browserEnv(process.env) });
}

/**
 * Captures before and after screenshots (and optional videos) for every scenario and viewport.
 * A failing cell records its error and does not stop other cells.
 * `total` and `failed` count after-side cells only. A before-side failure is expected when the PR
 * adds a page or UI, so it is reported in `beforeFailed` and does not fail the gate.
 * @param {{
 *   beforeUrl: string, afterUrl: string, scenarios: Scenario[], viewports: Record<string, Viewport>,
 *   outDir: string, headers?: Record<string, string>, fullPage?: boolean, log?: (msg: string) => void
 * }} opts
 * @returns {Promise<{ manifest: Manifest, total: number, failed: number, beforeFailed: number }>}
 */
export async function capture({ beforeUrl, afterUrl, scenarios, viewports, outDir, headers = {}, fullPage = true, log = () => {} }) {
  const bases = { before: new URL(beforeUrl).href, after: new URL(afterUrl).href };
  await mkdir(outDir, { recursive: true });
  const browser = await launchChromium();
  /** @type {Manifest} */
  const manifest = { version: 1, scenarios: [] };
  let total = 0;
  let failed = 0;
  let beforeFailed = 0;
  const used = new Set();
  try {
    for (const sc of scenarios) {
      const slug = slugify(sc.name, used);
      await mkdir(path.join(outDir, slug), { recursive: true });
      /** @type {import('./body.mjs').ManifestScenario} */
      const entry = { name: sc.name, slug, video: sc.video, cells: [] };
      for (const vpName of sc.viewports) {
        const vp = viewports[vpName];
        if (!vp) throw new UserError(`Scenario "${sc.name}" uses unknown viewport "${vpName}".`);
        /** @type {Record<'before' | 'after', Side>} */
        const sides = { before: {}, after: {} };
        for (const side of /** @type {const} */ (['before', 'after'])) {
          if (side === 'after') total++;
          log(`Capturing "${sc.name}" ${vpName} ${side}`);
          sides[side] = await captureCell({ browser, base: bases[side], scenario: sc, viewport: vp, outDir, file: `${slug}/${vpName}-${side}`, headers, fullPage });
          if (sides[side].error) {
            if (side === 'after') failed++;
            else beforeFailed++;
            log(`  failed: ${sides[side].error}`);
          }
        }
        entry.cells.push({ viewport: vpName, before: sides.before, after: sides.after });
      }
      manifest.scenarios.push(entry);
    }
  } finally {
    await browser.close();
    await rm(path.join(outDir, '.video-tmp'), { recursive: true, force: true });
  }
  await writeFile(path.join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return { manifest, total, failed, beforeFailed };
}

/**
 * @param {{
 *   browser: import('playwright').Browser, base: string, scenario: Scenario, viewport: Viewport,
 *   outDir: string, file: string, headers: Record<string, string>, fullPage: boolean
 * }} opts
 * @returns {Promise<Side>}
 */
async function captureCell({ browser, base, scenario, viewport, outDir, file, headers, fullPage }) {
  const videoDir = scenario.video ? path.join(outDir, '.video-tmp') : undefined;
  const size = { width: viewport.width, height: viewport.height };
  const context = await browser.newContext({
    viewport: size,
    isMobile: viewport.isMobile ?? false,
    hasTouch: viewport.hasTouch ?? false,
    deviceScaleFactor: viewport.deviceScaleFactor ?? 1,
    reducedMotion: 'reduce',
    // Service workers bypass context.route, so header scoping and routing would be incomplete.
    serviceWorkers: 'block',
    recordVideo: videoDir ? { dir: videoDir, size } : undefined,
  });
  /** @type {Side} */
  const result = {};
  /** @type {import('playwright').Page | undefined} */
  let page;
  /** @type {NavState} */
  const nav = { blocked: null, status: 0, url: '' };
  try {
    await context.route('**/*', makeRouteHandler({ origin: base, headers, onBlocked: (u) => { nav.blocked ??= u; } }));
    page = await context.newPage();
    const p = page;
    p.on('response', (res) => {
      const req = res.request();
      if (req.isNavigationRequest() && res.frame() === p.mainFrame()) {
        nav.status = res.status();
        nav.url = res.url();
      }
    });
    p.setDefaultTimeout(STEP_TIMEOUT_MS);
    p.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
    await navigate(p, resolveSafeUrl(base, scenario.path), base, nav);
    for (const step of scenario.steps) await runStep(p, base, step, nav);
    const shot = `${file}.png`;
    await p.screenshot({ path: path.join(outDir, shot), fullPage, animations: 'disabled', caret: 'hide' });
    result.screenshot = shot;
  } catch (err) {
    result.error = shortReason(err);
  } finally {
    await context.close().catch(() => {});
  }
  const video = page?.video();
  if (video) {
    if (result.error) {
      await video.delete().catch(() => {});
    } else {
      const name = `${file}.webm`;
      try {
        await video.saveAs(path.join(outDir, name));
        result.video = name;
      } catch (err) {
        result.error = `video: ${shortReason(err)}`;
        delete result.screenshot;
      }
      await video.delete().catch(() => {});
    }
  }
  return result;
}

/**
 * @typedef {{ blocked: string | null, status: number, url: string }} NavState
 */

/**
 * Throws when the main frame left the base origin or loaded an HTTP error page.
 * @param {import('playwright').Page} page
 * @param {string} base
 * @param {NavState} nav
 */
export function assertPageOk(page, base, nav) {
  const origin = new URL(base).origin;
  if (nav.blocked) throw new Error(`navigation to another origin blocked: ${safeOrigin(nav.blocked)}`);
  const current = page.url();
  if (current !== 'about:blank' && safeOrigin(current) !== origin) {
    throw new Error(`page left ${origin} for ${safeOrigin(current)}`);
  }
  if (nav.status >= 400) throw new Error(`HTTP ${nav.status} at ${safePath(nav.url)}`);
}

/** @param {string} u */
function safeOrigin(u) {
  try {
    return new URL(u).origin;
  } catch {
    return 'an invalid URL';
  }
}

/** @param {string} u */
function safePath(u) {
  try {
    return new URL(u).pathname;
  } catch {
    return '?';
  }
}

/**
 * @param {import('playwright').Page} page
 * @param {string} url
 * @param {string} base
 * @param {NavState} nav
 */
async function navigate(page, url, base, nav) {
  let res;
  try {
    res = await page.goto(url, { waitUntil: 'load' });
  } catch (err) {
    // A blocked cross-origin redirect surfaces as ERR_BLOCKED_BY_CLIENT. Report the cause.
    if (nav.blocked) assertPageOk(page, base, nav);
    throw err;
  }
  if (res) {
    nav.status = res.status();
    nav.url = res.url();
  }
  // Pages with polling or websockets never reach networkidle. Fall back after a bounded wait.
  await page.waitForLoadState('networkidle', { timeout: IDLE_TIMEOUT_MS }).catch(() => {});
  assertPageOk(page, base, nav);
}

/**
 * @param {import('playwright').Page} page
 * @param {string} base
 * @param {import('./scenarios.mjs').Step} step
 * @param {NavState} nav
 */
async function runStep(page, base, step, nav) {
  const [key, value] = /** @type {[string, any]} */ (Object.entries(step)[0]);
  try {
    switch (key) {
      case 'goto':
        return await navigate(page, resolveSafeUrl(base, value), base, nav);
      case 'click':
        await page.locator(value).click();
        break;
      case 'fill':
        await page.locator(value[0]).fill(value[1]);
        break;
      case 'press':
        await page.keyboard.press(value);
        break;
      case 'hover':
        await page.locator(value).hover();
        break;
      case 'waitFor':
        await page.locator(value).first().waitFor({ state: 'visible' });
        break;
      case 'wait':
        await page.waitForTimeout(value);
        break;
      case 'scroll':
        await page.evaluate((y) => window.scrollBy(0, y), value);
        break;
      default:
        throw new UserError(`Unsupported step "${key}".`);
    }
    if (key === 'click' || key === 'press') {
      // A click or key press can start a navigation. Let it settle, then check where the page is.
      await page.waitForLoadState('load', { timeout: NAV_TIMEOUT_MS }).catch(() => {});
    }
    assertPageOk(page, base, nav);
  } catch (err) {
    throw new Error(`step ${key}: ${shortReason(err)}`);
  }
}
