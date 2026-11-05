import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assertBasePath } from './body.mjs';
import { UserError } from './errors.mjs';

export const BRANCH = 'pr-visuals';
const MAX_ATTEMPTS = 4;

/**
 * @param {string[]} args
 * @param {{ cwd: string, env?: NodeJS.ProcessEnv }} opts
 * @returns {Promise<{ stdout: string, stderr: string }>}
 */
function git(args, { cwd, env }) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, env, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const e = /** @type {Error & { stderr?: string }} */ (new Error(`git ${args[0]} failed: ${stderr.trim().split('\n').slice(-3).join(' ')}`));
        e.stderr = stderr;
        reject(e);
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

/**
 * Builds the git environment. A token is passed as an HTTP header through GIT_CONFIG_* so it never
 * appears in argv or in the remote URL.
 * @param {string | undefined} token
 * @param {string} [serverUrl]
 * @returns {NodeJS.ProcessEnv}
 */
export function gitEnv(token, serverUrl = 'https://github.com') {
  /** @type {NodeJS.ProcessEnv} */
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  if (token) {
    const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
    env.GIT_CONFIG_COUNT = '1';
    env.GIT_CONFIG_KEY_0 = `http.${new URL(serverUrl).origin}/.extraheader`;
    env.GIT_CONFIG_VALUE_0 = `AUTHORIZATION: basic ${basic}`;
  }
  return env;
}

/**
 * Builds the destination directory on the pr-visuals branch.
 * @param {{ pr: number, sha: string, runId?: string, runAttempt?: string }} opts
 */
export function destPath({ pr, sha, runId, runAttempt }) {
  if (!Number.isInteger(pr) || pr < 1) throw new UserError('PR number must be a positive integer.');
  const id = runId && /^\d+$/.test(runId) ? runId : String(Date.now());
  const attempt = runAttempt && /^\d+$/.test(runAttempt) && runAttempt !== '1' ? `-${runAttempt}` : '';
  return assertBasePath(`pr-${pr}/${sha.slice(0, 7)}-${id}${attempt}`);
}

/**
 * Commits files to the orphan pr-visuals branch and pushes. Retries on a rejected push.
 * Never force-pushes.
 * @param {{ remote: string, token?: string, serverUrl?: string, srcDir: string, files: string[], dest: string, message: string, log?: (m: string) => void }} opts
 * @returns {Promise<string>} the destination path
 */
export async function publishFiles({ remote, token, serverUrl, srcDir, files, dest, message, log = () => {} }) {
  const base = assertBasePath(dest);
  for (const f of files) {
    if (path.isAbsolute(f) || f.split('/').some((s) => !/^[A-Za-z0-9._-]+$/.test(s) || s === '.' || s === '..')) {
      throw new UserError(`Refusing to publish unsafe path "${f}".`);
    }
  }
  if (!files.length) throw new UserError('Nothing to publish.');
  if (!remote || remote.startsWith('-')) throw new UserError('Invalid git remote.');
  const env = gitEnv(token, serverUrl);
  /** @type {unknown} */
  let lastError;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'pr-visuals-git-'));
    try {
      const run = (/** @type {string[]} */ args) => git(args, { cwd: dir, env });
      await run(['init', '-q']);
      await run(['remote', 'add', 'origin', remote]);
      const { stdout } = await run(['ls-remote', '--heads', 'origin', `refs/heads/${BRANCH}`]);
      await run(['symbolic-ref', 'HEAD', `refs/heads/${BRANCH}`]);
      if (stdout.trim()) {
        // Trees only: old screenshots stay on the server and are not downloaded.
        await run(['fetch', '-q', '--depth=1', '--filter=blob:none', 'origin', BRANCH]);
        await run(['reset', '-q', '--soft', 'FETCH_HEAD']);
        await run(['read-tree', 'FETCH_HEAD']);
      }
      for (const f of files) {
        const target = path.join(dir, base, f);
        await mkdir(path.dirname(target), { recursive: true });
        await copyFile(path.join(srcDir, f), target);
      }
      await run(['add', '--', base]);
      await run([
        '-c', 'user.name=pr-visuals', '-c', 'user.email=pr-visuals@users.noreply.github.com',
        'commit', '-q', '--no-verify', '-m', message,
      ]);
      await run(['push', '-q', 'origin', `HEAD:refs/heads/${BRANCH}`]);
      return base;
    } catch (err) {
      lastError = err;
      const stderr = /** @type {{ stderr?: string }} */ (err).stderr ?? '';
      if (!/rejected|non-fast-forward|fetch first|cannot lock ref|failed to update ref/i.test(stderr) || attempt === MAX_ATTEMPTS) break;
      log(`Push rejected, retrying (${attempt}/${MAX_ATTEMPTS - 1})...`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  throw new UserError(`Could not publish to the ${BRANCH} branch: ${lastError instanceof Error ? lastError.message : lastError}`);
}

/**
 * Lists the files referenced by a manifest.
 * @param {import('./body.mjs').Manifest} manifest
 * @returns {string[]}
 */
export function manifestFiles(manifest) {
  const out = [];
  for (const sc of manifest.scenarios) {
    for (const c of sc.cells) {
      for (const side of [c.before, c.after]) {
        if (side.screenshot) out.push(side.screenshot);
        if (side.video) out.push(side.video);
      }
    }
  }
  return out;
}
