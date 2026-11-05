import { findBlock } from './body.mjs';

export const LABELS = Object.freeze({
  none: 'visuals:none',
  generate: 'visuals:generate',
  stillValid: 'visuals:still-valid',
});

export const DEFAULT_BOT_LOGIN = 'github-actions[bot]';
const RESULT_RE = /<!-- pr-visuals:result (\{[^<>]*?\}) -->/g;
const SHA_RE = /^[0-9a-f]{40}$/;

/**
 * @typedef {{ kind: 'captured', sha: string, failed: number } | { kind: 'still-valid', sha: string }} ResultMarker
 * @typedef {{ body?: string | null, user?: { login?: string, type?: string } | null }} Comment
 */

/**
 * Renders the hidden result marker that the bot puts in its PR comments.
 * @param {ResultMarker} marker
 */
export function renderResultMarker(marker) {
  if (!SHA_RE.test(marker.sha)) throw new Error('Invalid SHA for result marker.');
  return `<!-- pr-visuals:result ${JSON.stringify(marker)} -->`;
}

/**
 * Extracts result markers, oldest first, from comments written by the bot account.
 * Comments by anyone else are ignored, so a hand-written marker or body meta cannot pass the gate.
 * @param {Comment[]} comments in creation order
 * @param {string} [botLogin]
 * @returns {ResultMarker[]}
 */
export function botMarkers(comments, botLogin = DEFAULT_BOT_LOGIN) {
  /** @type {ResultMarker[]} */
  const out = [];
  for (const c of comments) {
    if (c.user?.login !== botLogin || c.user?.type !== 'Bot' || typeof c.body !== 'string') continue;
    for (const m of c.body.matchAll(RESULT_RE)) {
      let data;
      try {
        data = JSON.parse(m[1]);
      } catch {
        continue;
      }
      if (!data || typeof data.sha !== 'string' || !SHA_RE.test(data.sha)) continue;
      if (data.kind === 'captured' && Number.isInteger(data.failed) && data.failed >= 0) {
        out.push({ kind: 'captured', sha: data.sha, failed: data.failed });
      } else if (data.kind === 'still-valid') {
        out.push({ kind: 'still-valid', sha: data.sha });
      }
    }
  }
  return out;
}

/**
 * Returns the newest captured marker, or null.
 * @param {ResultMarker[]} markers
 * @returns {{ kind: 'captured', sha: string, failed: number } | null}
 */
export function latestCaptured(markers) {
  for (let i = markers.length - 1; i >= 0; i--) {
    const m = markers[i];
    if (m.kind === 'captured') return m;
  }
  return null;
}

/** @param {number} n */
export function failedReason(n) {
  return `${n} ${n === 1 ? 'capture' : 'captures'} failed. Fix the scenario steps and apply ${LABELS.generate}.`;
}

/**
 * Decides whether a PR passes the visuals gate. Only bot result markers count.
 * The body must still hold a visuals block, so reviewers can see what was confirmed.
 * @param {{ labels: string[], body: string | null | undefined, headSha: string, markers: ResultMarker[] }} input
 * @returns {{ ok: boolean, reason: string }}
 */
export function checkVisuals({ labels, body, headSha, markers }) {
  if (labels.includes(LABELS.none)) return { ok: true, reason: `Label ${LABELS.none} is present.` };
  const noBlock = { ok: false, reason: `Apply ${LABELS.generate} (with a scenarios block) or ${LABELS.none}.` };
  let forHead = null;
  for (let i = markers.length - 1; i >= 0; i--) {
    if (markers[i].sha === headSha) {
      forHead = markers[i];
      break;
    }
  }
  if (forHead) {
    if (!findBlock(body)) {
      return { ok: false, reason: `The visuals block is missing from the PR description. Apply ${LABELS.generate}.` };
    }
    if (forHead.kind === 'captured') {
      return forHead.failed === 0
        ? { ok: true, reason: `Visuals match ${headSha.slice(0, 7)}.` }
        : { ok: false, reason: failedReason(forHead.failed) };
    }
    return { ok: true, reason: `Visuals were confirmed still valid for ${headSha.slice(0, 7)}.` };
  }
  const captured = latestCaptured(markers);
  if (!captured) return noBlock;
  return {
    ok: false,
    reason:
      `Visuals were captured on ${captured.sha.slice(0, 7)}. Apply ${LABELS.generate} to recapture, ` +
      `or ${LABELS.stillValid} if the new commits do not change the UI.`,
  };
}
