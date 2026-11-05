import { execFile } from 'node:child_process';
import { appendFile, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { assertRepo, assertSha, readMeta, renderBlock, replaceMeta, upsertBlock } from './body.mjs';
import { capture } from './capture.mjs';
import { checkVisuals, LABELS } from './check.mjs';
import { DEFAULT_VIEWPORTS, loadConfig, parseConfig, templateUrl } from './config.mjs';
import { resolveDeploymentUrl } from './deployments.mjs';
import { UserError } from './errors.mjs';
import { createGitHub } from './github.mjs';
import { parseHeadersEnv } from './headers.mjs';
import { destPath, manifestFiles, publishFiles } from './publish.mjs';
import { parseScenariosFromBody, parseScenariosJson, SCENARIOS_DOC_URL } from './scenarios.mjs';

export const HELP = `Usage: pr-visuals <command> [options]

Commands for GitHub Actions (read GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_EVENT_PATH):
  check          Pass or fail the visuals gate for the pull request.
  generate       Capture visuals, publish them, and update the PR description.
  still-valid    Mark the current head commit as confirmed.

Commands for local use:
  capture --before-url URL --after-url URL --scenarios FILE|- --out DIR [--config FILE]
                 Capture screenshots and videos. Prints a JSON manifest.
  render --manifest FILE --repo OWNER/REPO --pr N --sha SHA --base-path PATH
                 Print the visuals block for files already on the pr-visuals branch.
  publish --manifest FILE --pr N --sha SHA [--repo OWNER/REPO] [--remote NAME|URL]
                 Push the files to the pr-visuals branch with local git credentials.
                 Print the visuals block.

Environment:
  PR_VISUALS_CONFIG          Config path for CI commands (default .github/pr-visuals.json).
  PR_VISUALS_HEADERS         JSON object of HTTP headers. Sent only to the before and after origins.
  PR_VISUALS_CHROMIUM_PATH   Chromium binary to use instead of the Playwright default.

Options:
  -h, --help     Show this help.
`;

/** @param {string} msg */
const log = (msg) => process.stderr.write(`${msg}\n`);

/**
 * @param {string[]} argv
 * @returns {Promise<number>} exit code
 */
export async function main(argv) {
  const [command, ...rest] = argv;
  if (!command || command === '-h' || command === '--help' || command === 'help') {
    process.stdout.write(HELP);
    return command ? 0 : 1;
  }
  try {
    switch (command) {
      case 'check':
        return await cmdCheck();
      case 'generate':
        return await cmdGenerate();
      case 'still-valid':
        return await cmdStillValid();
      case 'capture':
        return await cmdCapture(rest);
      case 'render':
        return await cmdRender(rest);
      case 'publish':
        return await cmdPublish(rest);
      default:
        log(`Unknown command "${command}".\n`);
        process.stdout.write(HELP);
        return 2;
    }
  } catch (err) {
    log(`pr-visuals: ${formatError(err)}`);
    return 1;
  }
}

/** @param {unknown} err */
function formatError(err) {
  if (err instanceof UserError) {
    return [err.message, ...err.details.map((d) => `  - ${d}`), ...(err.hint ? [err.hint] : [])].join('\n');
  }
  return err instanceof Error ? err.stack ?? err.message : String(err);
}

/** @param {unknown} err */
function formatErrorMarkdown(err) {
  if (err instanceof UserError) {
    return [err.message, ...err.details.map((d) => `- ${d.replace(/[<>]/g, '')}`), ...(err.hint ? ['', err.hint] : [])].join('\n');
  }
  return 'Unexpected error. See the workflow log.';
}

// ---------- CI context ----------

/**
 * @returns {Promise<{ gh: import('./github.mjs').GitHub, owner: string, repo: string, number: number, token: string }>}
 */
async function ciContext() {
  const token = process.env.GITHUB_TOKEN ?? '';
  const full = process.env.GITHUB_REPOSITORY ?? '';
  const [owner, repo] = full.split('/');
  assertRepo(owner, repo);
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) throw new UserError('GITHUB_EVENT_PATH is not set. Run this command in GitHub Actions.');
  const event = JSON.parse(await readFile(eventPath, 'utf8'));
  const number = event?.pull_request?.number ?? event?.number;
  if (!Number.isInteger(number)) throw new UserError('The event has no pull request number. Trigger on pull_request.');
  const gh = createGitHub({ token, apiUrl: process.env.GITHUB_API_URL || undefined });
  return { gh, owner, repo, number, token };
}

/**
 * @param {import('./github.mjs').GitHub} gh
 * @param {string} owner
 * @param {string} repo
 * @param {number} number
 */
async function getPull(gh, owner, repo, number) {
  const pr = await gh.request('GET', `/repos/${owner}/${repo}/pulls/${number}`);
  return {
    body: /** @type {string} */ (pr.body ?? ''),
    headSha: /** @type {string} */ (pr.head.sha),
    baseRef: /** @type {string} */ (pr.base.ref),
    labels: /** @type {string[]} */ ((pr.labels ?? []).map((/** @type {{ name: string }} */ l) => l.name)),
  };
}

/** @param {string} text */
async function writeSummary(text) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (file) await appendFile(file, `${text}\n`);
}

function runUrl() {
  const server = process.env.GITHUB_SERVER_URL || 'https://github.com';
  const { GITHUB_REPOSITORY: r, GITHUB_RUN_ID: id } = process.env;
  return r && id ? `${server}/${r}/actions/runs/${id}` : '(run URL unavailable)';
}

/**
 * @param {import('./github.mjs').GitHub} gh
 * @param {string} owner
 * @param {string} repo
 * @param {number} number
 * @param {string} label
 */
async function removeLabel(gh, owner, repo, number, label) {
  await gh.request('DELETE', `/repos/${owner}/${repo}/issues/${number}/labels/${encodeURIComponent(label)}`, { allow404: true });
}

// ---------- check ----------

async function cmdCheck() {
  const { gh, owner, repo, number } = await ciContext();
  const pr = await getPull(gh, owner, repo, number);
  const result = checkVisuals({ labels: pr.labels, body: pr.body, headSha: pr.headSha });
  await writeSummary(`### pr-visuals\n\n${result.ok ? 'Passed' : 'Failed'}: ${result.reason}`);
  if (result.ok) {
    log(`ok: ${result.reason}`);
    return 0;
  }
  process.stdout.write(`::error title=pr-visuals::${result.reason}\n`);
  return 1;
}

// ---------- generate ----------

async function cmdGenerate() {
  const { gh, owner, repo, number, token } = await ciContext();
  const comment = await gh.request('POST', `/repos/${owner}/${repo}/issues/${number}/comments`, {
    body: { body: `Received \`${LABELS.generate}\`. Capturing visuals: ${runUrl()}` },
  });
  /** @param {string} text */
  const report = (text) => gh.request('PATCH', `/repos/${owner}/${repo}/issues/comments/${comment.id}`, { body: { body: text } });
  await removeLabel(gh, owner, repo, number, LABELS.generate);

  const outDir = await mkdtemp(path.join(os.tmpdir(), 'pr-visuals-'));
  try {
    const pr = await getPull(gh, owner, repo, number);
    const config = await loadCiConfig(gh, owner, repo, pr.baseRef);
    let scenarios;
    try {
      scenarios = parseScenariosFromBody(pr.body, Object.keys(config.viewports));
    } catch (err) {
      if (err instanceof UserError) err.hint = `Add a scenarios block to the PR description. Format: ${SCENARIOS_DOC_URL}`;
      throw err;
    }
    const headers = parseHeadersEnv(process.env.PR_VISUALS_HEADERS);
    const vars = { number, sha: pr.headSha };
    if (!config.before || !config.after) throw new UserError('Config needs "before" and "after".');
    const beforeUrl = templateUrl(config.before.url, vars);
    const afterUrl =
      'url' in config.after
        ? templateUrl(config.after.url, vars)
        : await resolveDeploymentUrl({
            gh, owner, repo, sha: pr.headSha, environment: config.after.environment,
            timeoutMs: config.after.timeoutMinutes * 60000, log,
          });
    log(`Before: ${new URL(beforeUrl).origin}  After: ${new URL(afterUrl).origin}`);

    const { manifest, total, failed } = await capture({
      beforeUrl, afterUrl, scenarios, viewports: config.viewports, outDir, headers, fullPage: config.fullPage, log,
    });
    if (failed === total) throw new UserError(`Every capture failed. First error: ${firstError(manifest)}`);

    const dest = destPath({ pr: number, sha: pr.headSha, runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT });
    const server = process.env.GITHUB_SERVER_URL || 'https://github.com';
    await publishFiles({
      remote: `${server}/${owner}/${repo}.git`, token, serverUrl: server, srcDir: outDir,
      files: manifestFiles(manifest), dest, message: `pr-visuals: PR #${number} at ${pr.headSha.slice(0, 7)}`, log,
    });
    const block = renderBlock({ manifest, owner, repo, basePath: dest, sha: pr.headSha, confirmed: [] });
    // Read the body again right before writing to reduce the window for clobbering edits.
    const fresh = await getPull(gh, owner, repo, number);
    await gh.request('PATCH', `/repos/${owner}/${repo}/pulls/${number}`, { body: { body: upsertBlock(fresh.body, block) } });

    const partial = failed ? ` ${failed} of ${total} captures failed. See the table.` : '';
    await report(`Captured visuals for ${pr.headSha.slice(0, 7)}. See the Visuals section of the PR description.${partial}\n\nRun: ${runUrl()}`);
    await writeSummary(`### pr-visuals\n\nCaptured ${total - failed} of ${total} cells for ${pr.headSha.slice(0, 7)}.`);
    return 0;
  } catch (err) {
    await report(`Could not capture visuals.\n\n${formatErrorMarkdown(err)}\n\nRun: ${runUrl()}`).catch(() => {});
    throw err;
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
}

/** @param {import('./body.mjs').Manifest} manifest */
function firstError(manifest) {
  for (const sc of manifest.scenarios) for (const c of sc.cells) for (const s of [c.before, c.after]) if (s.error) return s.error;
  return 'unknown';
}

/**
 * Reads the config from the workspace. Falls back to the PR base branch through the API, so the
 * job works without a checkout.
 * @param {import('./github.mjs').GitHub} gh
 * @param {string} owner
 * @param {string} repo
 * @param {string} baseRef
 */
async function loadCiConfig(gh, owner, repo, baseRef) {
  const rel = process.env.PR_VISUALS_CONFIG || '.github/pr-visuals.json';
  if (path.isAbsolute(rel) || rel.split(/[\\/]/).includes('..')) throw new UserError(`Config path "${rel}" must be relative to the repository root.`);
  const local = path.join(process.env.GITHUB_WORKSPACE || process.cwd(), rel);
  if (await stat(local).then((s) => s.isFile(), () => false)) return loadConfig(local);
  const data = await gh.request('GET', `/repos/${owner}/${repo}/contents/${rel.split('/').map(encodeURIComponent).join('/')}`, {
    query: { ref: baseRef }, allow404: true,
  });
  if (!data || typeof data.content !== 'string') {
    throw new UserError(`Config ${rel} not found in the workspace or on ${baseRef}.`);
  }
  return parseConfig(Buffer.from(data.content, 'base64').toString('utf8'));
}

// ---------- still-valid ----------

async function cmdStillValid() {
  const { gh, owner, repo, number } = await ciContext();
  await removeLabel(gh, owner, repo, number, LABELS.stillValid);
  const pr = await getPull(gh, owner, repo, number);
  const meta = readMeta(pr.body);
  /** @param {string} text */
  const comment = (text) => gh.request('POST', `/repos/${owner}/${repo}/issues/${number}/comments`, { body: { body: text } });
  if (!meta) {
    await comment(`Cannot apply \`${LABELS.stillValid}\`: the PR description has no visuals block. Apply \`${LABELS.generate}\` first.`);
    process.stdout.write('::error title=pr-visuals::No visuals block to confirm.\n');
    return 1;
  }
  const confirmed = meta.confirmed.includes(pr.headSha) ? meta.confirmed : [...meta.confirmed, pr.headSha];
  const body = replaceMeta(pr.body, { version: 1, sha: meta.sha, confirmed });
  await gh.request('PATCH', `/repos/${owner}/${repo}/pulls/${number}`, { body: { body } });
  await comment(`Marked visuals as still valid for ${pr.headSha.slice(0, 7)}.`);
  await writeSummary(`### pr-visuals\n\nMarked visuals as still valid for ${pr.headSha.slice(0, 7)}.`);
  return 0;
}

// ---------- local commands ----------

/**
 * @param {string[]} args
 * @param {Record<string, { type: 'string' | 'boolean' }>} options
 * @param {string[]} required
 */
function parse(args, options, required) {
  const { values } = parseArgs({ args, options, strict: true, allowPositionals: false });
  const missing = required.filter((k) => values[k] === undefined);
  if (missing.length) throw new UserError(`Missing option(s): ${missing.map((m) => `--${m}`).join(', ')}. Run pr-visuals --help.`);
  return /** @type {Record<string, string>} */ (values);
}

/** @param {string} value */
function parsePr(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new UserError(`--pr must be a positive integer.`);
  return n;
}

/** @param {string} value */
function parseRepo(value) {
  const [owner, repo, extra] = String(value).split('/');
  if (extra !== undefined) throw new UserError('--repo must be OWNER/REPO.');
  assertRepo(owner, repo);
  return { owner, repo };
}

/** @param {string} file */
async function readInput(file) {
  if (file === '-') {
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    return Buffer.concat(chunks).toString('utf8');
  }
  return readFile(file, 'utf8');
}

/** @param {string[]} args */
async function cmdCapture(args) {
  const v = parse(args, {
    'before-url': { type: 'string' }, 'after-url': { type: 'string' }, scenarios: { type: 'string' },
    config: { type: 'string' }, out: { type: 'string' },
  }, ['before-url', 'after-url', 'scenarios', 'out']);
  const config = v.config ? await loadConfig(v.config, { requireSources: false }) : { viewports: { ...DEFAULT_VIEWPORTS }, fullPage: true };
  const text = await readInput(v.scenarios);
  const names = Object.keys(config.viewports);
  // Accept a bare JSON file or a PR description that contains the scenarios block.
  const scenarios = text.includes('<!-- pr-visuals:scenarios') ? parseScenariosFromBody(text, names) : parseScenariosJson(text, names);
  const beforeUrl = templateCheck(v['before-url']);
  const afterUrl = templateCheck(v['after-url']);
  const outDir = path.resolve(v.out);
  const { manifest, total, failed } = await capture({
    beforeUrl, afterUrl, scenarios, viewports: config.viewports, outDir,
    headers: parseHeadersEnv(process.env.PR_VISUALS_HEADERS), fullPage: config.fullPage, log,
  });
  process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
  log(`Captured ${total - failed} of ${total} cells into ${outDir}. Manifest: ${path.join(outDir, 'manifest.json')}`);
  return failed === total ? 1 : 0;
}

/** @param {string} value */
function templateCheck(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new UserError(`"${value}" must use http or https.`);
  return url.href;
}

/** @param {string} file */
async function readManifest(file) {
  const data = JSON.parse(await readFile(file, 'utf8'));
  if (data?.version !== 1 || !Array.isArray(data.scenarios)) throw new UserError(`${file} is not a pr-visuals manifest.`);
  return /** @type {import('./body.mjs').Manifest} */ (data);
}

/** @param {string[]} args */
async function cmdRender(args) {
  const v = parse(args, {
    manifest: { type: 'string' }, repo: { type: 'string' }, pr: { type: 'string' }, sha: { type: 'string' }, 'base-path': { type: 'string' },
  }, ['manifest', 'repo', 'pr', 'sha', 'base-path']);
  const { owner, repo } = parseRepo(v.repo);
  parsePr(v.pr);
  assertSha(v.sha);
  const manifest = await readManifest(v.manifest);
  process.stdout.write(`${renderBlock({ manifest, owner, repo, basePath: v['base-path'], sha: v.sha })}\n`);
  return 0;
}

/** @param {string[]} args */
async function cmdPublish(args) {
  const v = parse(args, {
    manifest: { type: 'string' }, pr: { type: 'string' }, sha: { type: 'string' }, repo: { type: 'string' }, remote: { type: 'string' },
  }, ['manifest', 'pr', 'sha']);
  const pr = parsePr(v.pr);
  assertSha(v.sha);
  const manifest = await readManifest(v.manifest);
  const remoteArg = v.remote ?? 'origin';
  const remote = /^[A-Za-z0-9._-]+$/.test(remoteArg) ? await gitRemoteUrl(remoteArg) : remoteArg;
  const { owner, repo } = v.repo ? parseRepo(v.repo) : repoFromRemote(remote);
  const dest = destPath({ pr, sha: v.sha });
  await publishFiles({
    remote, srcDir: path.dirname(path.resolve(v.manifest)), files: manifestFiles(manifest), dest,
    message: `pr-visuals: PR #${pr} at ${v.sha.slice(0, 7)}`, log,
  });
  process.stdout.write(`${renderBlock({ manifest, owner, repo, basePath: dest, sha: v.sha })}\n`);
  return 0;
}

/** @param {string} name */
function gitRemoteUrl(name) {
  return new Promise((resolve, reject) => {
    execFile('git', ['remote', 'get-url', '--', name], (err, stdout) => {
      if (err) reject(new UserError(`Cannot read git remote "${name}". Run in the repository or pass --remote URL.`));
      else resolve(stdout.trim());
    });
  });
}

/** @param {string} remote */
export function repoFromRemote(remote) {
  const m = /github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(remote);
  if (!m) throw new UserError(`Cannot find OWNER/REPO in remote "${remote}". Pass --repo.`);
  assertRepo(m[1], m[2]);
  return { owner: m[1], repo: m[2] };
}
