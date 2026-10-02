export interface Shareable {
  url: string | null;
  headline: string;
}

export interface ShareTarget {
  id: 'buffer' | 'pinterest' | 'tumblr' | 'email';
  label: string;
  href: string;
}

/** Desktop share links for the external services we support. */
export function shareTargets(item: Shareable): ShareTarget[] {
  if (!item.url) return [];
  const url = encodeURIComponent(item.url);
  const text = encodeURIComponent(item.headline);
  return [
    { id: 'buffer', label: 'Buffer', href: `https://buffer.com/add?url=${url}&text=${text}` },
    {
      id: 'pinterest',
      label: 'Pinterest',
      href: `https://pinterest.com/pin/create/button/?url=${url}&description=${text}`,
    },
    {
      id: 'tumblr',
      label: 'Tumblr',
      href: `https://www.tumblr.com/widgets/share/tool?canonicalUrl=${url}&title=${text}`,
    },
    { id: 'email', label: 'Email', href: `mailto:?subject=${text}&body=${url}` },
  ];
}

export function canNativeShare(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.share === 'function';
}

/** Opens the OS share sheet (Web Share API). Resolves false if the user cancelled. */
export async function nativeShare(item: Shareable): Promise<boolean> {
  if (!item.url || !canNativeShare()) return false;
  try {
    await navigator.share({ title: item.headline, url: item.url });
    return true;
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') return false;
    throw err;
  }
}
