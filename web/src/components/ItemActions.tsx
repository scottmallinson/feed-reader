import { useEffect, useRef, useState } from 'react';
import { canNativeShare, nativeShare, shareTargets } from '../share';
import type { Board, Item } from '../types';

interface Props {
  item: Item;
  boards: Board[];
  onUpdate: (patch: Partial<Pick<Item, 'is_read' | 'is_saved' | 'board_id'>>) => void;
}

export function ItemActions({ item, boards, onUpdate }: Props) {
  return (
    <div className="actions" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        className={`icon-btn ${item.is_read ? '' : 'active'}`}
        title={item.is_read ? 'Mark as unread' : 'Mark as read'}
        aria-pressed={!item.is_read}
        onClick={() => onUpdate({ is_read: !item.is_read })}
      >
        {item.is_read ? '○' : '●'}
      </button>
      <button
        type="button"
        className={`icon-btn ${item.is_saved ? 'active saved' : ''}`}
        title={item.is_saved ? 'Remove from saved' : 'Save for later'}
        aria-pressed={item.is_saved}
        onClick={() => onUpdate({ is_saved: !item.is_saved })}
      >
        {item.is_saved ? '★' : '☆'}
      </button>
      {boards.length > 0 && (
        <select
          className="board-select"
          title="Add to board"
          value={item.board_id ?? ''}
          onChange={(e) => onUpdate({ board_id: e.target.value ? Number(e.target.value) : null })}
        >
          <option value="">No board</option>
          {boards.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
      )}
      <ShareMenu item={item} />
    </div>
  );
}

function ShareMenu({ item }: { item: Item }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  if (!item.url) return null;
  const targets = shareTargets(item);

  return (
    <div className="share" ref={ref}>
      <button
        type="button"
        className="icon-btn"
        title="Share"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        ⤴
      </button>
      {open && (
        <div className="menu" role="menu">
          {canNativeShare() && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                void nativeShare(item);
              }}
            >
              Share…
            </button>
          )}
          {targets.map((t) => (
            <a
              key={t.id}
              role="menuitem"
              href={t.href}
              target={t.id === 'email' ? undefined : '_blank'}
              rel="noopener noreferrer"
              onClick={() => setOpen(false)}
            >
              {t.label}
            </a>
          ))}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              void navigator.clipboard?.writeText(item.url!);
            }}
          >
            Copy link
          </button>
        </div>
      )}
    </div>
  );
}
