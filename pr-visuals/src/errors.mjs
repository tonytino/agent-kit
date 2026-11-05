/** An error whose message is safe to show to users and post in a PR comment. */
export class UserError extends Error {
  /**
   * @param {string} message
   * @param {{ details?: string[], hint?: string }} [opts]
   */
  constructor(message, opts = {}) {
    super(message);
    this.name = 'UserError';
    this.details = opts.details ?? [];
    this.hint = opts.hint;
  }
}

/**
 * First line of an error message, without ANSI codes, capped in length.
 * Playwright messages carry a multi-line call log that is noise in a table cell.
 * @param {unknown} err
 * @param {number} [max]
 */
export function shortReason(err, max = 160) {
  const raw = err instanceof Error ? err.message : String(err);
  // eslint-disable-next-line no-control-regex
  const line = raw.replace(/\u001b\[[0-9;]*m/g, '').split('\n').find((l) => l.trim()) ?? 'unknown error';
  const trimmed = line.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 3)}...` : trimmed;
}
