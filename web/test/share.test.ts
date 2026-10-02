import { describe, expect, it } from 'vitest';
import { shareTargets } from '../src/share';

describe('shareTargets', () => {
  it('builds encoded share URLs for each service', () => {
    const targets = shareTargets({ url: 'https://ex.com/a?b=1&c=2', headline: 'Tiny LLMs & you' });
    const byId = Object.fromEntries(targets.map((t) => [t.id, t.href]));
    const url = 'https%3A%2F%2Fex.com%2Fa%3Fb%3D1%26c%3D2';
    const text = 'Tiny%20LLMs%20%26%20you';
    expect(byId).toEqual({
      buffer: `https://buffer.com/add?url=${url}&text=${text}`,
      pinterest: `https://pinterest.com/pin/create/button/?url=${url}&description=${text}`,
      tumblr: `https://www.tumblr.com/widgets/share/tool?canonicalUrl=${url}&title=${text}`,
      email: `mailto:?subject=${text}&body=${url}`,
    });
  });

  it('returns nothing for items without a URL', () => {
    expect(shareTargets({ url: null, headline: 'x' })).toEqual([]);
  });
});
