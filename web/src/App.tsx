import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError, setToken, type ItemQuery } from './api';
import { ArticleView } from './components/ArticleView';
import { ItemList } from './components/ItemList';
import { Sidebar } from './components/Sidebar';
import type { Board, Feed, Item, ReadStatus, Selection, ViewMode } from './types';

const PAGE_SIZE = { headlines: 50, magazine: 30, full: 15 } as const;
const MODE_KEY = 'feed-reader-mode';
const STATUS_KEY = 'feed-reader-status';

function stored<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return allowed.includes(v as T) ? (v as T) : fallback;
  } catch {
    return fallback;
  }
}

function remember(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // ignore
  }
}

type Patch = Partial<Pick<Item, 'is_read' | 'is_saved' | 'board_id'>>;

export function App() {
  const [boards, setBoards] = useState<Board[]>([]);
  const [feeds, setFeeds] = useState<Feed[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const [selection, setSelection] = useState<Selection>({ type: 'all' });
  const [mode, setMode] = useState<ViewMode>(() =>
    stored(MODE_KEY, ['headlines', 'magazine', 'full'] as const, 'magazine'),
  );
  const [status, setStatus] = useState<ReadStatus>(() =>
    stored(STATUS_KEY, ['unread', 'all'] as const, 'unread'),
  );
  const [search, setSearch] = useState('');
  const [activeSearch, setActiveSearch] = useState('');
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsToken, setNeedsToken] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  const handleError = useCallback((err: unknown) => {
    if (err instanceof ApiError && err.status === 401) setNeedsToken(true);
    else setError(err instanceof Error ? err.message : String(err));
  }, []);

  const loadSidebar = useCallback(async () => {
    try {
      const [b, f] = await Promise.all([api.boards(), api.feeds()]);
      setBoards(b);
      setFeeds(f);
    } catch (err) {
      handleError(err);
    }
  }, [handleError]);

  const query = useMemo<ItemQuery>(() => {
    const q: ItemQuery = {
      // Saved items stay visible after they are read.
      status: selection.type === 'saved' ? 'all' : status,
      content: mode === 'full',
      limit: PAGE_SIZE[mode],
      q: activeSearch || undefined,
    };
    if (selection.type === 'saved') q.saved = true;
    if (selection.type === 'board') q.board_id = selection.id;
    if (selection.type === 'feed') q.feed_id = selection.id;
    return q;
  }, [selection, status, mode, activeSearch]);

  const loadItems = useCallback(
    async (append = false) => {
      setLoading(true);
      setError(null);
      try {
        const offset = append ? itemsRef.current.length : 0;
        const page = await api.items({ ...query, offset: activeSearch ? 0 : offset });
        setItems((prev) => (append ? [...prev, ...page] : page));
        setHasMore(!activeSearch && page.length === query.limit);
      } catch (err) {
        handleError(err);
      } finally {
        setLoading(false);
      }
    },
    [query, handleError],
  );

  useEffect(() => {
    void loadSidebar();
  }, [loadSidebar]);

  useEffect(() => {
    void loadItems(false);
    window.scrollTo({ top: 0 });
  }, [loadItems]);

  const updateItem = useCallback(
    async (item: Item, patch: Patch) => {
      setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, ...patch } : i)));
      try {
        await api.updateItem(item.id, patch);
        void loadSidebar();
      } catch (err) {
        setItems((prev) => prev.map((i) => (i.id === item.id ? item : i)));
        handleError(err);
      }
    },
    [loadSidebar, handleError],
  );

  const openIndex = openId ? items.findIndex((i) => i.id === openId) : -1;
  const openItem = openIndex >= 0 ? items[openIndex] : null;

  const open = useCallback(
    (item: Item) => {
      setOpenId(item.id);
      if (!item.is_read) void updateItem(item, { is_read: true });
    },
    [updateItem],
  );

  const title = (() => {
    if (activeSearch) return `Search: “${activeSearch}”`;
    if (selection.type === 'saved') return 'Saved for later';
    if (selection.type === 'board') return boards.find((b) => b.id === selection.id)?.name ?? 'Board';
    if (selection.type === 'feed') {
      const f = feeds.find((x) => x.id === selection.id);
      return f?.title ?? f?.url ?? 'Feed';
    }
    return 'All articles';
  })();

  async function markAllRead() {
    if (selection.type === 'saved') return;
    const scope =
      selection.type === 'board'
        ? { board_id: selection.id }
        : selection.type === 'feed'
          ? { feed_id: selection.id }
          : {};
    const label = selection.type === 'all' ? 'all articles' : `“${title}”`;
    if (!window.confirm(`Mark ${label} as read?`)) return;
    try {
      await api.markAllRead(scope);
      await Promise.all([loadItems(false), loadSidebar()]);
    } catch (err) {
      handleError(err);
    }
  }

  async function refresh() {
    try {
      if (selection.type === 'feed') {
        await api.refreshFeed(selection.id);
      } else {
        await api.refreshAll();
        await new Promise((r) => setTimeout(r, 2500));
      }
      await Promise.all([loadItems(false), loadSidebar()]);
    } catch (err) {
      handleError(err);
    }
  }

  function select(s: Selection) {
    setSelection(s);
    setActiveSearch('');
    setSearch('');
    setMenuOpen(false);
  }

  if (needsToken) {
    return (
      <form
        className="token-gate"
        onSubmit={(e) => {
          e.preventDefault();
          const token = new FormData(e.currentTarget).get('token')?.toString() ?? '';
          setToken(token || null);
          setNeedsToken(false);
          void loadSidebar();
          void loadItems(false);
        }}
      >
        <h1>Feed Reader</h1>
        <p>This server requires an API token.</p>
        <input name="token" type="password" placeholder="API token" autoFocus aria-label="API token" />
        <button type="submit">Continue</button>
      </form>
    );
  }

  return (
    <div className={`app ${menuOpen ? 'menu-open' : ''}`}>
      <Sidebar
        boards={boards}
        feeds={feeds}
        selection={selection}
        onSelect={select}
        onSubscribe={async (url, boardId) => {
          const feed = await api.subscribe(url, boardId);
          await loadSidebar();
          select({ type: 'feed', id: feed.id });
          if (feed.refresh.error) setError(`Subscribed, but the first fetch failed: ${feed.refresh.error}`);
        }}
        onCreateBoard={async (name) => {
          try {
            await api.createBoard(name);
            await loadSidebar();
          } catch (err) {
            handleError(err);
          }
        }}
        onDeleteBoard={async (board) => {
          if (!window.confirm(`Delete board “${board.name}”? Its feeds stay subscribed.`)) return;
          await api.deleteBoard(board.id).catch(handleError);
          if (selection.type === 'board' && selection.id === board.id) select({ type: 'all' });
          await loadSidebar();
        }}
        onUnsubscribe={async (feed) => {
          if (!window.confirm(`Unsubscribe from “${feed.title ?? feed.url}”?`)) return;
          await api.unsubscribe(feed.id).catch(handleError);
          if (selection.type === 'feed' && selection.id === feed.id) select({ type: 'all' });
          await Promise.all([loadSidebar(), loadItems(false)]);
        }}
        onMoveFeed={async (feed, boardId) => {
          await api.setFeedBoard(feed.id, boardId).catch(handleError);
          await loadSidebar();
        }}
      />
      <div className="scrim" onClick={() => setMenuOpen(false)} />

      <main className="main">
        <header className="toolbar">
          <button type="button" className="icon-btn menu-toggle" onClick={() => setMenuOpen(true)} title="Menu">
            ☰
          </button>
          <h1 className="title">{title}</h1>
          <form
            className="search"
            onSubmit={(e) => {
              e.preventDefault();
              setActiveSearch(search.trim());
            }}
          >
            <input
              type="search"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                if (!e.target.value) setActiveSearch('');
              }}
              placeholder="Search articles"
              aria-label="Search articles"
            />
          </form>
          <div className="segmented" role="group" aria-label="Read filter">
            {(['unread', 'all'] as const).map((s) => (
              <button
                key={s}
                type="button"
                aria-pressed={status === s}
                onClick={() => {
                  setStatus(s);
                  remember(STATUS_KEY, s);
                }}
              >
                {s === 'unread' ? 'Unread' : 'All'}
              </button>
            ))}
          </div>
          <div className="segmented" role="group" aria-label="Display">
            {(
              [
                ['headlines', 'Headlines', '≡'],
                ['magazine', 'Magazine', '▤'],
                ['full', 'Full', '¶'],
              ] as const
            ).map(([m, label, icon]) => (
              <button
                key={m}
                type="button"
                title={label}
                aria-pressed={mode === m}
                onClick={() => {
                  setMode(m);
                  remember(MODE_KEY, m);
                }}
              >
                <span aria-hidden="true">{icon}</span>
                <span className="seg-label">{label}</span>
              </button>
            ))}
          </div>
          <button type="button" className="icon-btn" onClick={refresh} title="Refresh feeds">
            ↻
          </button>
          {selection.type !== 'saved' && (
            <button type="button" className="icon-btn" onClick={markAllRead} title="Mark all as read">
              ✓
            </button>
          )}
        </header>

        {error && (
          <div className="banner" role="alert">
            {error}
            <button type="button" className="icon-btn small" onClick={() => setError(null)}>
              ✕
            </button>
          </div>
        )}

        {items.length === 0 && !loading ? (
          <div className="empty">
            {feeds.length === 0
              ? 'Follow a feed from the sidebar to get started.'
              : activeSearch
                ? 'No articles match your search.'
                : status === 'unread'
                  ? 'All caught up.'
                  : 'No articles here yet.'}
          </div>
        ) : (
          <ItemList items={items} mode={mode} boards={boards} onOpen={open} onUpdate={updateItem} />
        )}

        {loading && <div className="muted center">Loading…</div>}
        {hasMore && !loading && (
          <div className="center">
            <button type="button" className="more" onClick={() => loadItems(true)}>
              Load more
            </button>
          </div>
        )}
      </main>

      {openItem && (
        <ArticleView
          item={openItem}
          boards={boards}
          onClose={() => setOpenId(null)}
          onUpdate={(patch) => updateItem(openItem, patch)}
          onPrev={openIndex > 0 ? () => open(items[openIndex - 1]) : undefined}
          onNext={openIndex < items.length - 1 ? () => open(items[openIndex + 1]) : undefined}
        />
      )}
    </div>
  );
}
