import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assertBasePath } from './body.mjs';
import { UserError } from './errors.mjs';

export const BRANCH = 'pr-visuals';
const MAX_ATTEMPTS = 4;

/**
 * Runs git without a shell. Optional input goes to stdin.
 * @param {string[]} args
 * @param {{ cwd: string, env?: NodeJS.ProcessEnv, input?: string | Buffer }} opts
 * @returns {Promise<{ stdout: string, stderr: string }>}
 */
function git(args, { cwd, env, input }) {
  return new Promise((resolve, reject) => {
    const child = execFile('git', args, { cwd, env, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const e = /** @type {Error & { stderr?: string }} */ (new Error(`git ${args[0]} failed: ${stderr.trim().split('\n').slice(-3).join(' ')}`));
        e.stderr = stderr;
        reject(e);
      } else {
        resolve({ stdout, stderr });
      }
    });
    // git may exit before it reads stdin. The exit code reports real failures, so ignore EPIPE.
    child.stdin?.on('error', () => {});
    child.stdin?.end(input ?? '');
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

// Vercel builds every pushed branch by default. This file turns that off for pr-visuals.
// Other hosts ignore it.
export const VERCEL_JSON = '{"git":{"deploymentEnabled":false}}\n';

/**
 * @typedef {{ mode: string, type: string, sha: string }} TreeEntry
 */

/**
 * Commits files to the orphan pr-visuals branch and pushes. Retries on a rejected push.
 * Never force-pushes. The commit is built with plumbing commands from the existing trees, so the
 * blobs of earlier screenshots are never downloaded.
 * @param {{
 *   remote: string, token?: string, serverUrl?: string, srcDir: string, files: string[], dest: string,
 *   message: string, log?: (m: string) => void,
 *   hooks?: { beforePush?: (attempt: number) => Promise<void>, inspect?: (gitDir: string) => Promise<void> }
 * }} opts
 * @returns {Promise<string>} the destination path
 */
export async function publishFiles({ remote, token, serverUrl, srcDir, files, dest, message, log = () => {}, hooks = {} }) {
  const base = assertBasePath(dest);
  for (const f of files) {
    if (path.isAbsolute(f) || f.split('/').some((s) => !/^[A-Za-z0-9._-]+$/.test(s) || s === '.' || s === '..')) {
      throw new UserError(`Refusing to publish unsafe path "${f}".`);
    }
  }
  if (!files.length) throw new UserError('Nothing to publish.');
  if (!remote || remote.startsWith('-')) throw new UserError('Invalid git remote.');
  const env = {
    ...gitEnv(token, serverUrl),
    GIT_AUTHOR_NAME: 'pr-visuals', GIT_AUTHOR_EMAIL: 'pr-visuals@users.noreply.github.com',
    GIT_COMMITTER_NAME: 'pr-visuals', GIT_COMMITTER_EMAIL: 'pr-visuals@users.noreply.github.com',
  };
  /** @type {unknown} */
  let lastError;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'pr-visuals-git-'));
    try {
      const run = (/** @type {string[]} */ args, /** @type {string | Buffer | undefined} */ input) => git(args, { cwd: dir, env, input });
      await run(['init', '-q', '--bare']);
      await run(['remote', 'add', 'origin', remote]);
      const { stdout } = await run(['ls-remote', '--heads', 'origin', `refs/heads/${BRANCH}`]);
      let parent = null;
      if (stdout.trim()) {
        // Commits and trees only. The blobs of earlier screenshots stay on the server.
        await run(['fetch', '-q', '--depth=1', '--filter=blob:none', 'origin', BRANCH]);
        parent = (await run(['rev-parse', 'FETCH_HEAD^{commit}'])).stdout.trim();
      }

      /** @param {string} treeish */
      const lsTree = async (treeish) => {
        /** @type {Map<string, TreeEntry>} */
        const out = new Map();
        const { stdout: raw } = await run(['ls-tree', '-z', treeish]);
        for (const rec of raw.split('\0')) {
          if (!rec) continue;
          const tab = rec.indexOf('\t');
          const [mode, type, sha] = rec.slice(0, tab).split(' ');
          out.set(rec.slice(tab + 1), { mode, type, sha });
        }
        return out;
      };
      /** @param {Map<string, TreeEntry>} entries */
      const mktree = async (entries) => {
        const input = [...entries].map(([name, e]) => `${e.mode} ${e.type} ${e.sha}\t${name}\0`).join('');
        // --missing skips the existence check, which would fetch old blobs from a partial clone.
        return (await run(['mktree', '-z', '--missing'], input)).stdout.trim();
      };
      /** @param {string | Buffer} content */
      const blob = async (content) => (await run(['hash-object', '-w', '--stdin'], content)).stdout.trim();

      // Tree of the new files.
      /** @typedef {{ [name: string]: Dir | string }} Dir */
      /** @type {Dir} */
      const root = {};
      for (const f of files) {
        const segs = f.split('/');
        let node = root;
        for (const seg of segs.slice(0, -1)) node = /** @type {Dir} */ (node[seg] ??= {});
        node[segs[segs.length - 1]] = await blob(await readFile(path.join(srcDir, f)));
      }
      /** @param {Dir} node @returns {Promise<string>} */
      const writeDir = async (node) => {
        /** @type {Map<string, TreeEntry>} */
        const entries = new Map();
        for (const [name, v] of Object.entries(node)) {
          entries.set(name, typeof v === 'string' ? { mode: '100644', type: 'blob', sha: v } : { mode: '040000', type: 'tree', sha: await writeDir(v) });
        }
        return mktree(entries);
      };
      const newTree = await writeDir(root);

      // Graft the new tree at `base` into the existing trees, one level at a time.
      /** @param {string | null} treeish @param {string[]} segs @param {Map<string, TreeEntry>} [extra] @returns {Promise<string>} */
      const graft = async (treeish, segs, extra) => {
        if (!segs.length) return newTree;
        const entries = treeish ? await lsTree(treeish) : new Map();
        for (const [k, v] of extra ?? []) entries.set(k, v);
        const child = entries.get(segs[0]);
        const childTree = child?.type === 'tree' ? child.sha : null;
        entries.set(segs[0], { mode: '040000', type: 'tree', sha: await graft(childTree, segs.slice(1)) });
        return mktree(entries);
      };
      const vercel = new Map([['vercel.json', { mode: '100644', type: 'blob', sha: await blob(VERCEL_JSON) }]]);
      const tree = await graft(parent, base.split('/'), vercel);
      const commit = (await run(['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', message])).stdout.trim();
      await hooks.inspect?.(dir);
      await hooks.beforePush?.(attempt);
      await run(['push', '-q', 'origin', `${commit}:refs/heads/${BRANCH}`]);
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
