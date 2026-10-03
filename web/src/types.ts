export type ReadStatus = 'read' | 'unread' | 'all';
export type ViewMode = 'headlines' | 'magazine' | 'full';

export interface Board {
  id: number;
  name: string;
  slug: string;
  unread_count: number;
}

export interface Feed {
  id: number;
  url: string;
  title: string | null;
  slug: string | null;
  site_url: string | null;
  last_fetched: string | null;
  last_error: string | null;
  board_id: number | null;
  unread_count: number;
}

export interface Item {
  id: string;
  feed_id: number;
  feed_title: string | null;
  url: string | null;
  headline: string;
  author: string | null;
  summary: string | null;
  thumbnail_url: string | null;
  published_date: string | null;
  is_read: boolean;
  is_saved: boolean;
  board_id: number | null;
  full_content?: string | null;
}

export type Selection =
  | { type: 'all' }
  | { type: 'saved' }
  | { type: 'board'; id: number }
  | { type: 'feed'; id: number };
