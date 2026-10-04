import type { Board, Feed, Item, ReadStatus } from './types';

export interface OpmlImportResult {
  added: { id: number; url: string; title: string | null; board: string | null }[];
  skipped: { url: string; title: string | null; reason: 'already subscribed' | 'duplicate in file' }[];
  boardsCreated: string[];
  invalid: string[];
}

const TOKEN_KEY = 'feed-reader-token';

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // storage unavailable; token only lives for this page load
  }
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body) headers.set('content-type', 'application/json');
  const token = getToken();
  if (token) headers.set('authorization', `Bearer ${token}`);
  const res = await fetch(`/api${path}`, { ...init, headers });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(body.error ?? `Request failed (${res.status})`, res.status);
  }
  return res.status === 204 ? (undefined as T) : res.json();
}

export interface ItemQuery {
  feed_id?: number;
  board_id?: number;
  status?: ReadStatus;
  saved?: boolean;
  content?: boolean;
  q?: string;
  limit?: number;
  offset?: number;
}

function qs(params: object): string {
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '' && v !== false) search.set(k, String(v));
  }
  const s = search.toString();
  return s ? `?${s}` : '';
}

export const api = {
  boards: () => request<Board[]>('/boards'),
  createBoard: (name: string) =>
    request<Board>('/boards', { method: 'POST', body: JSON.stringify({ name }) }),
  deleteBoard: (id: number) => request<void>(`/boards/${id}`, { method: 'DELETE' }),

  feeds: () => request<Feed[]>('/feeds'),
  subscribe: (url: string, board_id: number | null) =>
    request<Feed & { refresh: { inserted: number; error?: string } }>('/feeds', {
      method: 'POST',
      body: JSON.stringify({ url, board_id }),
    }),
  updateFeed: (id: number, patch: { url?: string; title?: string | null; board_id?: number | null }) =>
    request<Feed & { refresh?: { inserted: number; error?: string } }>(`/feeds/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  setFeedBoard: (id: number, board_id: number | null) =>
    request<Feed>(`/feeds/${id}`, { method: 'PATCH', body: JSON.stringify({ board_id }) }),
  importOpml: (opml: string) =>
    request<OpmlImportResult>('/opml', { method: 'POST', body: JSON.stringify({ opml }) }),
  unsubscribe: (id: number) => request<void>(`/feeds/${id}`, { method: 'DELETE' }),
  refreshFeed: (id: number) =>
    request<{ inserted: number; error?: string }>(`/feeds/${id}/refresh`, { method: 'POST' }),
  refreshAll: () =>
    request<{ summary: { feeds: number; inserted: number; errors: number } | null }>('/refresh', {
      method: 'POST',
    }),

  items: (query: ItemQuery) => request<Item[]>(`/items${qs(query)}`),
  item: (id: string) => request<Item>(`/items/${id}`),
  updateItem: (id: string, patch: Partial<Pick<Item, 'is_read' | 'is_saved' | 'board_id'>>) =>
    request<Item>(`/items/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  markAllRead: (scope: { feed_id?: number; board_id?: number }) =>
    request<{ updated: number }>('/items/mark-read', {
      method: 'POST',
      body: JSON.stringify(scope),
    }),
};
