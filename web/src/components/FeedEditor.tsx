import { useEffect, useState, type FormEvent } from 'react';
import { sortByName } from '../sort';
import type { Board, Feed } from '../types';

export interface FeedEdit {
  url?: string;
  title?: string | null;
  board_id?: number | null;
}

interface Props {
  feed: Feed;
  boards: Board[];
  onClose: () => void;
  /** Saves the changes; resolves to an error message when the new address could not be fetched. */
  onSave: (patch: FeedEdit) => Promise<string | null>;
}

/** Dialog for renaming a feed, changing its address or moving it to another board. */
export function FeedEditor({ feed, boards, onClose, onSave }: Props) {
  const [title, setTitle] = useState(feed.custom_title ?? '');
  const [url, setUrl] = useState(feed.url);
  const [boardId, setBoardId] = useState(feed.board_id === null ? '' : String(feed.board_id));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !busy && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const patch: FeedEdit = {};
    if (url.trim() !== feed.url) patch.url = url.trim();
    if ((title.trim() || null) !== (feed.custom_title ?? null)) patch.title = title.trim() || null;
    const board = boardId ? Number(boardId) : null;
    if (board !== feed.board_id) patch.board_id = board;
    if (Object.keys(patch).length === 0) return onClose();
    setBusy(true);
    setError(null);
    try {
      const fetchError = await onSave(patch);
      if (fetchError) setError(`Saved, but fetching the new address failed: ${fetchError}`);
      else onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="overlay" onClick={() => !busy && onClose()}>
      <form
        className="dialog stack-form"
        onSubmit={submit}
        onClick={(e) => e.stopPropagation()}
        aria-labelledby="feed-editor-title"
      >
        <h2 id="feed-editor-title">Edit feed</h2>
        {feed.last_error && (
          <p className="error" role="status">
            Last fetch failed: {feed.last_error}
          </p>
        )}
        <label>
          Name
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={feed.feed_title ?? 'Use the feed’s own title'}
            maxLength={200}
          />
          <small className="muted">Leave blank to use the title the feed publishes.</small>
        </label>
        <label>
          Feed address
          <input type="url" required value={url} onChange={(e) => setUrl(e.target.value)} />
          <small className="muted">A feed URL, or a website’s address to use the feed it advertises.</small>
        </label>
        <label>
          Board
          <select value={boardId} onChange={(e) => setBoardId(e.target.value)}>
            <option value="">No board</option>
            {sortByName(boards).map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </label>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" className="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </div>
  );
}
