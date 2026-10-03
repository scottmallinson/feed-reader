import type { OpmlImportResult } from './api';

function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** One-line summary of an OPML import for the sidebar. */
export function describeImport(r: OpmlImportResult): string {
  const already = r.skipped.filter((s) => s.reason === 'already subscribed').length;
  const dupes = r.skipped.length - already;
  const parts = [`Added ${plural(r.added.length, 'feed')}`];
  if (already) parts.push(`${already} already followed`);
  if (dupes) parts.push(`${plural(dupes, 'duplicate')} in the file`);
  if (r.invalid.length) parts.push(`${plural(r.invalid.length, 'invalid URL')} ignored`);
  if (r.boardsCreated.length) parts.push(`new ${r.boardsCreated.length === 1 ? 'board' : 'boards'}: ${r.boardsCreated.join(', ')}`);
  return `${parts.join('; ')}.`;
}
