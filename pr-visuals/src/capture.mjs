import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { shortReason, UserError } from './errors.mjs';
import { makeHeaderRouteHandler } from './headers.mjs';
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
  return chromium.launch({ executablePath });
}

/**
 * Captures before and after screenshots (and optional videos) for every scenario and viewport.
 * A failing cell records its error and does not stop other cells.
 * @param {{
 *   beforeUrl: string, afterUrl: string, scenarios: Scenario[], viewports: Record<string, Viewport>,
 *   outDir: string, headers?: Record<string, string>, fullPage?: boolean, log?: (msg: string) => void
 * }} opts
 * @returns {Promise<{ manifest: Manifest, total: number, failed: number }>}
 */
export async function capture({ beforeUrl, afterUrl, scenarios, viewports, outDir, headers = {}, fullPage = true, log = () => {} }) {
  const bases = { before: new URL(beforeUrl).href, after: new URL(afterUrl).href };
  await mkdir(outDir, { recursive: true });
  const browser = await launchChromium();
  /** @type {Manifest} */
  const manifest = { version: 1, scenarios: [] };
  let total = 0;
  let failed = 0;
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
          total++;
          log(`Capturing "${sc.name}" ${vpName} ${side}`);
          sides[side] = await captureCell({ browser, base: bases[side], scenario: sc, viewport: vp, outDir, file: `${slug}/${vpName}-${side}`, headers, fullPage });
          if (sides[side].error) {
            failed++;
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
  return { manifest, total, failed };
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
  let page;
  try {
    if (Object.keys(headers).length) await context.route('**/*', makeHeaderRouteHandler(base, headers));
    page = await context.newPage();
    page.setDefaultTimeout(STEP_TIMEOUT_MS);
    page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
    await navigate(page, resolveSafeUrl(base, scenario.path));
    for (const step of scenario.steps) await runStep(page, base, step);
    const shot = `${file}.png`;
    await page.screenshot({ path: path.join(outDir, shot), fullPage, animations: 'disabled', caret: 'hide' });
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
 * @param {import('playwright').Page} page
 * @param {string} url
 */
async function navigate(page, url) {
  await page.goto(url, { waitUntil: 'load' });
  // Pages with polling or websockets never reach networkidle. Fall back after a bounded wait.
  await page.waitForLoadState('networkidle', { timeout: IDLE_TIMEOUT_MS }).catch(() => {});
}

/**
 * @param {import('playwright').Page} page
 * @param {string} base
 * @param {import('./scenarios.mjs').Step} step
 */
async function runStep(page, base, step) {
  const [key, value] = /** @type {[string, any]} */ (Object.entries(step)[0]);
  try {
    switch (key) {
      case 'goto':
        return await navigate(page, resolveSafeUrl(base, value));
      case 'click':
        return await page.locator(value).click();
      case 'fill':
        return await page.locator(value[0]).fill(value[1]);
      case 'press':
        return await page.keyboard.press(value);
      case 'hover':
        return await page.locator(value).hover();
      case 'waitFor':
        return await page.locator(value).first().waitFor({ state: 'visible' });
      case 'wait':
        return await page.waitForTimeout(value);
      case 'scroll':
        return await page.evaluate((y) => window.scrollBy(0, y), value);
      default:
        throw new UserError(`Unsupported step "${key}".`);
    }
  } catch (err) {
    throw new Error(`step ${key}: ${shortReason(err)}`);
  }
}
