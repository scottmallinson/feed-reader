import { Fragment, useState, type FormEvent, type ReactNode } from 'react';
import type { Board, Feed, Selection } from '../types';

interface Props {
  boards: Board[];
  feeds: Feed[];
  selection: Selection;
  onSelect: (s: Selection) => void;
  onSubscribe: (url: string, boardId: number | null) => Promise<void>;
  onCreateBoard: (name: string) => Promise<void>;
  onDeleteBoard: (board: Board) => void;
  onUnsubscribe: (feed: Feed) => void;
  onMoveFeed: (feed: Feed, boardId: number | null) => void;
}

function same(a: Selection, b: Selection) {
  return a.type === b.type && ('id' in a ? a.id : 0) === ('id' in b ? b.id : 0);
}

function Count({ n }: { n: number }) {
  return n > 0 ? <span className="count">{n > 999 ? '999+' : n}</span> : null;
}

export function Sidebar(props: Props) {
  const { boards, feeds, selection, onSelect } = props;
  const [url, setUrl] = useState('');
  const [boardForNew, setBoardForNew] = useState<string>('');
  const [boardName, setBoardName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const totalUnread = feeds.reduce((n, f) => n + f.unread_count, 0);

  const nav = (s: Selection, label: string, count?: number, extra?: ReactNode, key?: string | number) => (
    <li key={key} className={same(s, selection) ? 'selected' : ''}>
      <button type="button" className="nav-item" onClick={() => onSelect(s)}>
        <span className="label">{label}</span>
        {count !== undefined && <Count n={count} />}
      </button>
      {extra}
    </li>
  );

  async function subscribe(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await props.onSubscribe(url.trim(), boardForNew ? Number(boardForNew) : null);
      setUrl('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function createBoard(e: FormEvent) {
    e.preventDefault();
    if (!boardName.trim()) return;
    await props.onCreateBoard(boardName.trim());
    setBoardName('');
  }

  const feedsIn = (boardId: number | null) => feeds.filter((f) => f.board_id === boardId);

  const feedRow = (f: Feed) =>
    nav(
      { type: 'feed', id: f.id },
      f.title ?? f.url,
      f.unread_count,
      <span className="row-tools">
        {f.last_error && (
          <span className="warn" title={`Last fetch failed: ${f.last_error}`}>
            !
          </span>
        )}
        <select
          aria-label="Move to board"
          title="Move to board"
          value={f.board_id ?? ''}
          onChange={(e) => props.onMoveFeed(f, e.target.value ? Number(e.target.value) : null)}
        >
          <option value="">No board</option>
          {boards.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
        <button type="button" className="icon-btn small" title="Unsubscribe" onClick={() => props.onUnsubscribe(f)}>
          ✕
        </button>
      </span>,
      f.id,
    );

  return (
    <nav className="sidebar">
      <div className="brand">Feed Reader</div>
      <ul className="nav">
        {nav({ type: 'all' }, 'All articles', totalUnread)}
        {nav({ type: 'saved' }, 'Saved for later')}
      </ul>

      <h4>Boards</h4>
      <ul className="nav">
        {boards.map((b) => (
          <Fragment key={b.id}>
            {nav(
              { type: 'board', id: b.id },
              b.name,
              b.unread_count,
              <span className="row-tools">
                <button
                  type="button"
                  className="icon-btn small"
                  title="Delete board"
                  onClick={() => props.onDeleteBoard(b)}
                >
                  ✕
                </button>
              </span>,
            )}
            {feedsIn(b.id).length > 0 && (
              <li className="plain">
                <ul className="nav nested">{feedsIn(b.id).map(feedRow)}</ul>
              </li>
            )}
          </Fragment>
        ))}
      </ul>
      <form className="inline-form" onSubmit={createBoard}>
        <input
          value={boardName}
          onChange={(e) => setBoardName(e.target.value)}
          placeholder="New board"
          aria-label="New board name"
        />
        <button type="submit" disabled={!boardName.trim()}>
          Add
        </button>
      </form>

      {feedsIn(null).length > 0 && <h4>Feeds</h4>}
      <ul className="nav">{feedsIn(null).map(feedRow)}</ul>

      <h4>Follow a feed</h4>
      <form className="stack-form" onSubmit={subscribe}>
        <input
          type="url"
          required
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://example.com/feed.xml"
          aria-label="Feed URL"
        />
        <div className="inline-form">
          <select value={boardForNew} onChange={(e) => setBoardForNew(e.target.value)} aria-label="Board">
            <option value="">No board</option>
            {boards.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
          <button type="submit" disabled={busy}>
            {busy ? 'Adding…' : 'Follow'}
          </button>
        </div>
        {error && <p className="error">{error}</p>}
      </form>
    </nav>
  );
}
