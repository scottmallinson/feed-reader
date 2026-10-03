import { useEffect, useState } from 'react';
import { api } from '../api';
import { relativeTime, summaryHtml } from '../format';
import type { Board, Item } from '../types';
import { ItemActions } from './ItemActions';
import { SafeHtml } from './SafeHtml';

interface Props {
  item: Item;
  boards: Board[];
  onClose: () => void;
  onUpdate: (patch: Partial<Pick<Item, 'is_read' | 'is_saved' | 'board_id'>>) => void;
  onPrev?: () => void;
  onNext?: () => void;
}

/** Reader overlay used by the headline and magazine views. */
export function ArticleView({ item, boards, onClose, onUpdate, onPrev, onNext }: Props) {
  const [content, setContent] = useState<string | null>(item.full_content ?? null);

  useEffect(() => {
    let cancelled = false;
    setContent(item.full_content ?? null);
    if (item.full_content === undefined) {
      api.item(item.id).then((full) => !cancelled && setContent(full.full_content ?? ''));
    }
    return () => {
      cancelled = true;
    };
  }, [item.id, item.full_content]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      if (e.key === 'Escape') onClose();
      if (e.key === 'j' || e.key === 'ArrowRight') onNext?.();
      if (e.key === 'k' || e.key === 'ArrowLeft') onPrev?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, onNext, onPrev]);

  return (
    <div className="overlay" onClick={onClose}>
      <article className="reader" onClick={(e) => e.stopPropagation()} aria-label={item.headline}>
        <div className="reader-bar">
          <button type="button" className="icon-btn" onClick={onPrev} disabled={!onPrev} title="Previous (k)">
            ‹
          </button>
          <button type="button" className="icon-btn" onClick={onNext} disabled={!onNext} title="Next (j)">
            ›
          </button>
          <ItemActions item={item} boards={boards} onUpdate={onUpdate} />
          <button type="button" className="icon-btn close" onClick={onClose} title="Close (Esc)">
            ✕
          </button>
        </div>
        <h1>
          <a href={item.url ?? undefined} target="_blank" rel="noopener noreferrer">
            {item.headline}
          </a>
        </h1>
        <p className="meta">
          {item.feed_title}
          {item.author && ` · ${item.author}`}
          {item.published_date && ` · ${relativeTime(item.published_date)}`}
        </p>
        {content === null ? (
          <p className="muted">Loading…</p>
        ) : (
          <SafeHtml className="content" html={content || summaryHtml(item.summary)} />
        )}
        {item.url && (
          <p>
            <a className="visit" href={item.url} target="_blank" rel="noopener noreferrer">
              Visit website ↗
            </a>
          </p>
        )}
      </article>
    </div>
  );
}
