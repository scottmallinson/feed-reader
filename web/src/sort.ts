// Case- and accent-insensitive, with natural number ordering ("Feed 2" before "Feed 10").
const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

/** Sorts by display name: `title` when set, otherwise the URL without its scheme and "www.". */
export function sortByName<T extends { title?: string | null; name?: string; url?: string }>(rows: T[]): T[] {
  const label = (r: T) =>
    (r.title ?? r.name ?? r.url ?? '').trim().replace(/^https?:\/\/(www\.)?/i, '');
  return [...rows].sort((a, b) => collator.compare(label(a), label(b)));
}
