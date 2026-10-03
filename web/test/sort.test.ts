import { describe, expect, it } from 'vitest';
import { sortByName } from '../src/sort';
import { describeImport } from '../src/importSummary';

describe('sortByName', () => {
  it('orders feeds alphabetically by title, ignoring case and accents, with natural numbers', () => {
    const feeds = [
      { title: 'zeta', url: 'https://z.test/feed' },
      { title: 'Écho', url: 'https://e.test/feed' },
      { title: 'Feed 10', url: 'https://f10.test' },
      { title: 'alpha', url: 'https://a.test/feed' },
      { title: 'Feed 2', url: 'https://f2.test' },
      { title: null, url: 'https://www.beta.test/rss' },
    ];
    expect(sortByName(feeds).map((f) => f.title ?? f.url)).toEqual([
      'alpha',
      'https://www.beta.test/rss',
      'Écho',
      'Feed 2',
      'Feed 10',
      'zeta',
    ]);
  });

  it('sorts boards by name and does not mutate its input', () => {
    const boards = [{ name: 'News' }, { name: 'ai research' }];
    expect(sortByName(boards).map((b) => b.name)).toEqual(['ai research', 'News']);
    expect(boards[0].name).toBe('News');
  });
});

describe('describeImport', () => {
  it('summarises added, skipped and invalid feeds', () => {
    expect(
      describeImport({
        added: [{ id: 1, url: 'a', title: 'A', board: null }, { id: 2, url: 'b', title: 'B', board: 'Tech' }],
        skipped: [
          { url: 'c', title: null, reason: 'already subscribed' },
          { url: 'a2', title: null, reason: 'duplicate in file' },
        ],
        boardsCreated: ['Tech'],
        invalid: ['ftp://x'],
      }),
    ).toBe('Added 2 feeds; 1 already followed; 1 duplicate in the file; 1 invalid URL ignored; new board: Tech.');
    expect(describeImport({ added: [], skipped: [], boardsCreated: [], invalid: [] })).toBe('Added 0 feeds.');
  });
});
