import { useState } from 'react';
import { clip, relativeTime, summaryHtml } from '../format';
import type { Board, Item, ViewMode } from '../types';
import { ItemActions } from './ItemActions';
import { SafeHtml } from './SafeHtml';

interface Props {
  items: Item[];
  mode: ViewMode;
  boards: Board[];
  onOpen: (item: Item) => void;
  onUpdate: (item: Item, patch: Partial<Pick<Item, 'is_read' | 'is_saved' | 'board_id'>>) => void;
}

function Meta({ item }: { item: Item }) {
  return (
    <span className="meta">
      {item.feed_title && <span className="feed-name">{item.feed_title}</span>}
      {item.author && <span> · {item.author}</span>}
      {item.published_date && (
        <time dateTime={item.published_date} title={new Date(item.published_date).toLocaleString()}>
          {' '}
          · {relativeTime(item.published_date)}
        </time>
      )}
    </span>
  );
}

function Thumbnail({ item }: { item: Item }) {
  const [failed, setFailed] = useState(false);
  if (item.thumbnail_url && !failed) {
    return (
      <img className="thumb" src={item.thumbnail_url} alt="" loading="lazy" onError={() => setFailed(true)} />
    );
  }
  return (
    <div className="thumb placeholder" aria-hidden="true">
      {(item.feed_title ?? '?').slice(0, 1).toUpperCase()}
    </div>
  );
}

export function ItemList({ items, mode, boards, onOpen, onUpdate }: Props) {
  if (mode === 'headlines') {
    return (
      <ul className="list headlines">
        {items.map((item) => (
          <li
            key={item.id}
            className={`row ${item.is_read ? 'read' : ''}`}
            onClick={() => onOpen(item)}
          >
            <span className="feed-name">{item.feed_title}</span>
            <span className="headline">{item.headline}</span>
            <span className="time">{relativeTime(item.published_date)}</span>
            <ItemActions item={item} boards={boards} onUpdate={(p) => onUpdate(item, p)} />
          </li>
        ))}
      </ul>
    );
  }

  if (mode === 'magazine') {
    return (
      <ul className="list magazine">
        {items.map((item) => (
          <li key={item.id} className={`card ${item.is_read ? 'read' : ''}`} onClick={() => onOpen(item)}>
            <Thumbnail item={item} />
            <div className="card-body">
              <h3>{item.headline}</h3>
              <Meta item={item} />
              <p>{clip(item.summary, 200)}</p>
              <ItemActions item={item} boards={boards} onUpdate={(p) => onUpdate(item, p)} />
            </div>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <div className="list full">
      {items.map((item) => (
        <article key={item.id} className={`full-item ${item.is_read ? 'read' : ''}`}>
          <header>
            <h2>
              <a href={item.url ?? undefined} target="_blank" rel="noopener noreferrer">
                {item.headline}
              </a>
            </h2>
            <Meta item={item} />
            <ItemActions item={item} boards={boards} onUpdate={(p) => onUpdate(item, p)} />
          </header>
          <SafeHtml className="content" html={item.full_content || summaryHtml(item.summary)} />
        </article>
      ))}
    </div>
  );
}
