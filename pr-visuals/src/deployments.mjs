import { UserError } from './errors.mjs';
import { sleep } from './github.mjs';

/**
 * Finds the URL of a successful GitHub deployment for a commit. Polls until the timeout.
 * Works for any host that posts deployment statuses (Vercel, Netlify, and others).
 * @param {{
 *   gh: import('./github.mjs').GitHub, owner: string, repo: string, sha: string, environment?: string,
 *   timeoutMs: number, intervalMs?: number, sleepImpl?: (ms: number) => Promise<void>, now?: () => number,
 *   log?: (msg: string) => void
 * }} opts
 * @returns {Promise<string>}
 */
export async function resolveDeploymentUrl({
  gh, owner, repo, sha, environment, timeoutMs, intervalMs = 15000, sleepImpl = sleep, now = Date.now, log = () => {},
}) {
  const deadline = now() + timeoutMs;
  for (;;) {
    const url = await findSuccessUrl({ gh, owner, repo, sha, environment });
    if (url) return url;
    if (now() + intervalMs > deadline) {
      const env = environment ? ` in environment "${environment}"` : '';
      throw new UserError(
        `No successful deployment${env} for ${sha.slice(0, 7)} after ${Math.round(timeoutMs / 60000)} minutes. ` +
          'Check that the host posts GitHub deployment statuses, or set "after.url" in the config.',
      );
    }
    log(`Waiting for a successful deployment of ${sha.slice(0, 7)}...`);
    await sleepImpl(intervalMs);
  }
}

/**
 * @param {{ gh: import('./github.mjs').GitHub, owner: string, repo: string, sha: string, environment?: string }} opts
 * @returns {Promise<string | null>}
 */
async function findSuccessUrl({ gh, owner, repo, sha, environment }) {
  /** @type {any[]} */
  const deployments = (await gh.request('GET', `/repos/${owner}/${repo}/deployments`, {
    query: { sha, environment, per_page: 30 },
  })) ?? [];
  deployments.sort((a, b) => Date.parse(b.created_at ?? 0) - Date.parse(a.created_at ?? 0) || (b.id ?? 0) - (a.id ?? 0));
  for (const d of deployments) {
    if (d.sha && d.sha !== sha) continue;
    /** @type {any[]} */
    const statuses = (await gh.request('GET', `/repos/${owner}/${repo}/deployments/${Number(d.id)}/statuses`, {
      query: { per_page: 100 },
    })) ?? [];
    const success = statuses.find((s) => s.state === 'success');
    if (!success) continue;
    const candidate = success.environment_url || success.target_url;
    if (typeof candidate === 'string' && /^https?:\/\//i.test(candidate)) return candidate;
  }
  return null;
}
