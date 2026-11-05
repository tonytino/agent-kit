import { execFile } from 'node:child_process';
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { assertRepo, assertSha, escapeText, readMeta, renderBlock, replaceMeta, upsertBlock } from './body.mjs';
import { capture } from './capture.mjs';
import { botMarkers, checkVisuals, DEFAULT_BOT_LOGIN, failedReason, LABELS, latestCaptured, renderResultMarker } from './check.mjs';
import { DEFAULT_VIEWPORTS, loadConfig, parseConfig, readRegularFile, templateUrl } from './config.mjs';
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
  capture        Capture screenshots and videos. Prints a JSON manifest.
  render         Print the visuals block for files already on the pr-visuals branch.
  publish        Push files to the pr-visuals branch with local git credentials.

Run "pr-visuals <command> --help" for the options of a command.

Environment:
  PR_VISUALS_CONFIG          Config path in the repository, read from the PR base branch
                             (default .github/pr-visuals.json). CI commands only.
  PR_VISUALS_HEADERS         JSON object of HTTP headers. Sent only to the before and after origins.
  PR_VISUALS_BOT_LOGIN       Account whose comments the check trusts (default ${DEFAULT_BOT_LOGIN}).
  PR_VISUALS_CHROMIUM_PATH   Chromium binary to use instead of the Playwright default.
`;

/** @type {Record<string, string>} */
export const COMMAND_HELP = {
  check: `Usage: pr-visuals check

Pass when visuals:none is set, or when a ${DEFAULT_BOT_LOGIN} result comment covers the head commit
with no failed captures. Writes the reason to $GITHUB_STEP_SUMMARY. Exit 1 on failure.
`,
  generate: `Usage: pr-visuals generate

Capture the scenarios in the PR description, publish the files to the pr-visuals branch, update the
visuals block, and post a result comment. Exit 1 when any capture failed.
`,
  'still-valid': `Usage: pr-visuals still-valid

Confirm the latest capture for the head commit. Refused when the latest capture had failures.
`,
  capture: `Usage: pr-visuals capture --before-url URL --after-url URL --scenarios FILE|- --out DIR [--config FILE]

Capture screenshots and videos. FILE is scenarios JSON or a PR description with a scenarios block.
Writes DIR/manifest.json and prints it. Exit 1 when every capture failed.
`,
  render: `Usage: pr-visuals render --manifest FILE --repo OWNER/REPO --pr N --sha SHA --base-path PATH

Print the visuals block for files already on the pr-visuals branch under PATH.
`,
  publish: `Usage: pr-visuals publish --manifest FILE --pr N --sha SHA [--repo OWNER/REPO] [--remote NAME|URL]

Push the files in the manifest to the pr-visuals branch with local git credentials. Print the
visuals block. --remote defaults to origin.
`,
};

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
  if (rest.includes('--help') || rest.includes('-h')) {
    if (COMMAND_HELP[command]) {
      process.stdout.write(COMMAND_HELP[command]);
      return 0;
    }
  }
  try {
    switch (command) {
      case 'check':
        return await cmdCheck();
      case 'generate':
        return await cmdGenerate();
      case 'still-valid':
        return await cmdStillValid();
      case 'begin':
        return await cmdBegin(rest);
      case 'report-failure':
        return await cmdReportFailure(rest);
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

/**
 * Error text for a PR comment. Message and details can hold user input, so they are escaped.
 * The hint is fixed text from this tool.
 * @param {unknown} err
 */
export function formatErrorMarkdown(err) {
  if (err instanceof UserError) {
    return [escapeText(err.message), ...err.details.map((d) => `- ${escapeText(d)}`), ...(err.hint ? ['', err.hint] : [])].join('\n');
  }
  return 'Unexpected error. See the workflow log.';
}

// ---------- CI context ----------

/**
 * @typedef {{ gh: import('./github.mjs').GitHub, owner: string, repo: string, number: number, token: string }} Ci
 * @returns {Promise<Ci>}
 */
async function ciContext() {
  const token = process.env.GITHUB_TOKEN ?? '';
  const full = process.env.GITHUB_REPOSITORY ?? '';
  const [owner, repo] = full.split('/');
  assertRepo(owner, repo);
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) throw new UserError('GITHUB_EVENT_PATH is not set. Run this command in GitHub Actions.');
  const event = JSON.parse(await readRegularFile(eventPath, 'event file'));
  const number = event?.pull_request?.number ?? event?.number;
  if (!Number.isInteger(number)) throw new UserError('The event has no pull request number. Trigger on pull_request.');
  const gh = createGitHub({ token, apiUrl: process.env.GITHUB_API_URL || undefined });
  return { gh, owner, repo, number, token };
}

/**
 * @param {Ci} ci
 */
async function getPull({ gh, owner, repo, number }) {
  const pr = await gh.request('GET', `/repos/${owner}/${repo}/pulls/${number}`);
  return {
    body: /** @type {string} */ (pr.body ?? ''),
    headSha: /** @type {string} */ (pr.head.sha),
    baseRef: /** @type {string} */ (pr.base.ref),
    labels: /** @type {string[]} */ ((pr.labels ?? []).map((/** @type {{ name: string }} */ l) => l.name)),
  };
}

/** @param {Ci} ci */
async function getMarkers({ gh, owner, repo, number }) {
  const comments = await gh.paginate(`/repos/${owner}/${repo}/issues/${number}/comments`);
  return botMarkers(comments, process.env.PR_VISUALS_BOT_LOGIN || DEFAULT_BOT_LOGIN);
}

/** @param {string} text */
async function writeSummary(text) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (file) await appendFile(file, `${text}\n`);
}

/**
 * @param {string} name
 * @param {string} value
 */
async function writeOutput(name, value) {
  const file = process.env.GITHUB_OUTPUT;
  if (file) await appendFile(file, `${name}=${value}\n`);
}

function runUrl() {
  const server = process.env.GITHUB_SERVER_URL || 'https://github.com';
  const { GITHUB_REPOSITORY: r, GITHUB_RUN_ID: id } = process.env;
  return r && id ? `${server}/${r}/actions/runs/${id}` : '(run URL unavailable)';
}

/** Marks that the CLI posted its own result, so the action's failure step stays quiet. */
function reportedFile() {
  const dir = process.env.RUNNER_TEMP;
  return dir ? path.join(dir, `pr-visuals-reported-${process.env.GITHUB_RUN_ID ?? '0'}`) : null;
}

async function markReported() {
  const file = reportedFile();
  if (file) await writeFile(file, 'yes\n');
}

/**
 * @param {Ci} ci
 * @param {string} label
 */
async function removeLabel({ gh, owner, repo, number }, label) {
  await gh.request('DELETE', `/repos/${owner}/${repo}/issues/${number}/labels/${encodeURIComponent(label)}`, { allow404: true });
}

/**
 * @param {Ci} ci
 * @param {string} text
 * @returns {Promise<number>} comment id
 */
async function postComment({ gh, owner, repo, number }, text) {
  const c = await gh.request('POST', `/repos/${owner}/${repo}/issues/${number}/comments`, { body: { body: text } });
  return c.id;
}

/**
 * @param {Ci} ci
 * @param {number} id
 * @param {string} text
 */
async function editComment({ gh, owner, repo }, id, text) {
  await gh.request('PATCH', `/repos/${owner}/${repo}/issues/comments/${id}`, { body: { body: text } });
}

function commentIdFromEnv() {
  const raw = process.env.PR_VISUALS_COMMENT_ID;
  return raw && /^\d+$/.test(raw) ? Number(raw) : null;
}

// ---------- begin / report-failure (action plumbing) ----------

/**
 * Removes the one-shot label and, for generate, posts the "Received" comment.
 * Needs no npm install. Writes comment-id to $GITHUB_OUTPUT.
 * @param {string[]} args
 */
async function cmdBegin(args) {
  const mode = args[0];
  if (mode !== 'generate' && mode !== 'still-valid') throw new UserError('Usage: pr-visuals begin generate|still-valid');
  const ci = await ciContext();
  if (mode === 'generate') {
    const id = await postComment(ci, `Received \`${LABELS.generate}\`. Capturing visuals: ${runUrl()}`);
    await writeOutput('comment-id', String(id));
  }
  await removeLabel(ci, mode === 'generate' ? LABELS.generate : LABELS.stillValid);
  return 0;
}

/**
 * Posts a failure note when the CLI stopped before it reported a result.
 * @param {string[]} args
 */
async function cmdReportFailure(args) {
  const mode = args[0] ?? 'pr-visuals';
  const file = reportedFile();
  if (file && (await readRegularFile(file, 'state file').then(() => true, () => false))) return 0;
  const ci = await ciContext();
  const text = `pr-visuals ${escapeText(mode)} failed before it reported a result. See the run: ${runUrl()}`;
  const id = commentIdFromEnv();
  if (id) await editComment(ci, id, text);
  else await postComment(ci, text);
  return 0;
}

// ---------- check ----------

async function cmdCheck() {
  const ci = await ciContext();
  const pr = await getPull(ci);
  const markers = pr.labels.includes(LABELS.none) ? [] : await getMarkers(ci);
  const result = checkVisuals({ labels: pr.labels, body: pr.body, headSha: pr.headSha, markers });
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
  const ci = await ciContext();
  const { owner, repo, number, token } = ci;
  let commentId = commentIdFromEnv();
  if (!commentId) {
    commentId = await postComment(ci, `Received \`${LABELS.generate}\`. Capturing visuals: ${runUrl()}`);
    await removeLabel(ci, LABELS.generate);
  }
  const id = commentId;
  /** @param {string} text */
  const report = async (text) => {
    await editComment(ci, id, text);
    await markReported();
  };

  const outDir = await mkdtemp(path.join(os.tmpdir(), 'pr-visuals-'));
  try {
    const pr = await getPull(ci);
    const headers = parseHeadersEnv(process.env.PR_VISUALS_HEADERS);
    const config = await loadCiConfig(ci, pr.baseRef, Object.keys(headers).length > 0);
    let scenarios;
    try {
      scenarios = parseScenariosFromBody(pr.body, Object.keys(config.viewports));
    } catch (err) {
      if (err instanceof UserError) err.hint = `Add a scenarios block to the PR description. Format: ${SCENARIOS_DOC_URL}`;
      throw err;
    }
    if (!config.before || !config.after) throw new UserError('Config needs "before" and "after".');
    const vars = { number, sha: pr.headSha };
    const beforeUrl = templateUrl(config.before.url, vars);
    const afterUrl =
      'url' in config.after
        ? templateUrl(config.after.url, vars)
        : await resolveDeploymentUrl({
            gh: ci.gh, owner, repo, sha: pr.headSha, environment: config.after.environment,
            timeoutMs: config.after.timeoutMinutes * 60000, log,
          });
    log(`Before: ${new URL(beforeUrl).origin}  After: ${new URL(afterUrl).origin}`);

    const { manifest, total, failed } = await capture({
      beforeUrl, afterUrl, scenarios, viewports: config.viewports, outDir, headers, fullPage: config.fullPage, log,
    });

    const dest = destPath({ pr: number, sha: pr.headSha, runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT });
    const files = manifestFiles(manifest);
    if (files.length) {
      const server = process.env.GITHUB_SERVER_URL || 'https://github.com';
      await publishFiles({
        remote: `${server}/${owner}/${repo}.git`, token, serverUrl: server, srcDir: outDir,
        files, dest, message: `pr-visuals: PR #${number} at ${pr.headSha.slice(0, 7)}`, log,
      });
    }
    const block = renderBlock({ manifest, owner, repo, basePath: dest, sha: pr.headSha, confirmed: [] });
    // Read the body again right before writing to reduce the window for clobbering edits.
    const fresh = await getPull(ci);
    await ci.gh.request('PATCH', `/repos/${owner}/${repo}/pulls/${number}`, { body: { body: upsertBlock(fresh.body, block) } });

    const marker = renderResultMarker({ kind: 'captured', sha: pr.headSha, failed });
    const sha7 = pr.headSha.slice(0, 7);
    if (failed) {
      await report(`Captured visuals for ${sha7}. ${failed} of ${total} captures failed. Fix the scenario steps and apply \`${LABELS.generate}\`. See the Visuals section of the PR description.\n\nRun: ${runUrl()}\n${marker}`);
      await writeSummary(`### pr-visuals\n\n${failedReason(failed)}`);
      process.stdout.write(`::error title=pr-visuals::${failedReason(failed)}\n`);
      return 1;
    }
    await report(`Captured visuals for ${sha7}. See the Visuals section of the PR description.\n\nRun: ${runUrl()}\n${marker}`);
    await writeSummary(`### pr-visuals\n\nCaptured ${total} of ${total} cells for ${sha7}.`);
    return 0;
  } catch (err) {
    await report(`Could not capture visuals.\n\n${formatErrorMarkdown(err)}\n\nRun: ${runUrl()}`).catch(() => {});
    throw err;
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
}

/**
 * Reads the config from the PR base branch through the API. The PR head cannot change where
 * secret headers go.
 * @param {Ci} ci
 * @param {string} baseRef
 * @param {boolean} hasHeaders
 */
async function loadCiConfig({ gh, owner, repo }, baseRef, hasHeaders) {
  const rel = process.env.PR_VISUALS_CONFIG || '.github/pr-visuals.json';
  if (path.isAbsolute(rel) || rel.split(/[\\/]/).some((s) => s === '..' || s === '.' || s === '')) {
    throw new UserError(`Config path "${rel}" must be a relative path in the repository.`);
  }
  const data = await gh.request('GET', `/repos/${owner}/${repo}/contents/${rel.split('/').map(encodeURIComponent).join('/')}`, {
    query: { ref: baseRef }, allow404: true,
  });
  if (!data || data.type !== 'file' || typeof data.content !== 'string') {
    throw new UserError(`Config ${rel} not found on the base branch ${baseRef}. Merge the config before you use the gate.`);
  }
  return parseConfig(Buffer.from(data.content, 'base64').toString('utf8'), { hasHeaders });
}

// ---------- still-valid ----------

async function cmdStillValid() {
  const ci = await ciContext();
  if (!process.env.PR_VISUALS_BEGUN) await removeLabel(ci, LABELS.stillValid);
  const pr = await getPull(ci);
  const sha7 = pr.headSha.slice(0, 7);
  /** @param {string} text */
  const refuse = async (text) => {
    await postComment(ci, text);
    await markReported();
    process.stdout.write(`::error title=pr-visuals::${text.replace(/`/g, '')}\n`);
    return 1;
  };
  const meta = readMeta(pr.body);
  const captured = latestCaptured(await getMarkers(ci));
  if (!meta || !captured) {
    return refuse(`Cannot apply \`${LABELS.stillValid}\`: there is no captured result to confirm. Apply \`${LABELS.generate}\` first.`);
  }
  if (captured.failed > 0) {
    return refuse(`Cannot apply \`${LABELS.stillValid}\`: the latest capture (${captured.sha.slice(0, 7)}) had ${captured.failed} failed captures. Fix the scenario steps and apply \`${LABELS.generate}\`.`);
  }
  const confirmed = meta.confirmed.includes(pr.headSha) ? meta.confirmed : [...meta.confirmed, pr.headSha];
  const body = replaceMeta(pr.body, { version: 1, sha: meta.sha, confirmed });
  await ci.gh.request('PATCH', `/repos/${ci.owner}/${ci.repo}/pulls/${ci.number}`, { body: { body } });
  await postComment(ci, `Marked visuals as still valid for ${sha7}.\n${renderResultMarker({ kind: 'still-valid', sha: pr.headSha })}`);
  await markReported();
  await writeSummary(`### pr-visuals\n\nMarked visuals as still valid for ${sha7}.`);
  return 0;
}

// ---------- local commands ----------

/**
 * @param {string[]} args
 * @param {Record<string, { type: 'string' | 'boolean' }>} options
 * @param {string[]} required
 * @param {string} command
 */
function parse(args, options, required, command) {
  let values;
  try {
    ({ values } = parseArgs({ args, options, strict: true, allowPositionals: false }));
  } catch (err) {
    throw new UserError(`${err instanceof Error ? err.message : err}\n\n${COMMAND_HELP[command]}`);
  }
  const missing = required.filter((k) => values[k] === undefined);
  if (missing.length) {
    throw new UserError(`Missing option(s): ${missing.map((m) => `--${m}`).join(', ')}.\n\n${COMMAND_HELP[command]}`);
  }
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
  return readRegularFile(file, 'scenarios file');
}

/** @param {string[]} args */
async function cmdCapture(args) {
  const v = parse(args, {
    'before-url': { type: 'string' }, 'after-url': { type: 'string' }, scenarios: { type: 'string' },
    config: { type: 'string' }, out: { type: 'string' },
  }, ['before-url', 'after-url', 'scenarios', 'out'], 'capture');
  const headers = parseHeadersEnv(process.env.PR_VISUALS_HEADERS);
  const config = v.config
    ? await loadConfig(v.config, { requireSources: false })
    : { viewports: { ...DEFAULT_VIEWPORTS }, fullPage: true };
  const text = await readInput(v.scenarios);
  const names = Object.keys(config.viewports);
  // Accept a bare JSON file or a PR description that contains the scenarios block.
  const scenarios = text.includes('<!-- pr-visuals:scenarios') ? parseScenariosFromBody(text, names) : parseScenariosJson(text, names);
  const beforeUrl = httpUrl(v['before-url']);
  const afterUrl = httpUrl(v['after-url']);
  const outDir = path.resolve(v.out);
  const { manifest, total, failed } = await capture({
    beforeUrl, afterUrl, scenarios, viewports: config.viewports, outDir, headers, fullPage: config.fullPage, log,
  });
  process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
  log(`Captured ${total - failed} of ${total} cells into ${outDir}. Manifest: ${path.join(outDir, 'manifest.json')}`);
  return failed === total ? 1 : 0;
}

/** @param {string} value */
function httpUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new UserError(`"${value}" is not a URL.`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new UserError(`"${value}" must use http or https.`);
  return url.href;
}

/** @param {string} file */
async function readManifest(file) {
  let data;
  try {
    data = JSON.parse(await readRegularFile(file, 'manifest'));
  } catch (err) {
    if (err instanceof UserError) throw err;
    throw new UserError(`${file} is not valid JSON.`);
  }
  if (data?.version !== 1 || !Array.isArray(data.scenarios)) throw new UserError(`${file} is not a pr-visuals manifest.`);
  return /** @type {import('./body.mjs').Manifest} */ (data);
}

/** @param {string[]} args */
async function cmdRender(args) {
  const v = parse(args, {
    manifest: { type: 'string' }, repo: { type: 'string' }, pr: { type: 'string' }, sha: { type: 'string' }, 'base-path': { type: 'string' },
  }, ['manifest', 'repo', 'pr', 'sha', 'base-path'], 'render');
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
  }, ['manifest', 'pr', 'sha'], 'publish');
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
