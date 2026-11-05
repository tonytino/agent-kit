import { readMeta } from './body.mjs';

export const LABELS = Object.freeze({
  none: 'visuals:none',
  generate: 'visuals:generate',
  stillValid: 'visuals:still-valid',
});

/**
 * Decides whether a PR passes the visuals gate.
 * @param {{ labels: string[], body: string | null | undefined, headSha: string }} input
 * @returns {{ ok: boolean, reason: string }}
 */
export function checkVisuals({ labels, body, headSha }) {
  if (labels.includes(LABELS.none)) return { ok: true, reason: `Label ${LABELS.none} is present.` };
  const meta = readMeta(body);
  if (!meta) {
    return { ok: false, reason: `Apply ${LABELS.generate} (with a scenarios block) or ${LABELS.none}.` };
  }
  if (meta.sha === headSha) return { ok: true, reason: `Visuals match ${headSha.slice(0, 7)}.` };
  if (meta.confirmed.includes(headSha)) {
    return { ok: true, reason: `Visuals were confirmed still valid for ${headSha.slice(0, 7)}.` };
  }
  return {
    ok: false,
    reason:
      `Visuals were captured on ${meta.sha.slice(0, 7)}. Apply ${LABELS.generate} to recapture, ` +
      `or ${LABELS.stillValid} if the new commits do not change the UI.`,
  };
}
