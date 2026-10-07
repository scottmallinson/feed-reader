import type { BookmarkImportResult, BookmarkReport, OpmlImportResult } from './api';

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

/** One-line summary of a bookmarks import for the sidebar. */
export function describeBookmarkImport(r: BookmarkImportResult): string {
  const parts = [`Saved ${plural(r.imported + r.matchedExisting, 'link')}`];
  if (r.matchedExisting) parts.push(`${r.matchedExisting} matched articles already in your feeds`);
  if (r.alreadySaved) parts.push(`${r.alreadySaved} already saved`);
  if (r.duplicates) parts.push(`${plural(r.duplicates, 'duplicate')} in the file`);
  if (r.invalid.length) parts.push(`${plural(r.invalid.length, 'invalid URL')} ignored`);
  if (r.imported) parts.push('fetching article text in the background, newest first');
  return `${parts.join('; ')}.`;
}

/** Progress line for background fetching of imported bookmarks. */
export function describeBookmarkProgress(r: BookmarkReport): string {
  const done = r.fetched + r.dead.length;
  if (r.pending > 0) {
    return `Bookmarks: ${done.toLocaleString()} of ${r.total.toLocaleString()} fetched, ${r.pending.toLocaleString()} to go.`;
  }
  return `Bookmarks: all ${r.total.toLocaleString()} fetched; ${plural(r.dead.length, 'dead link')}.`;
}
