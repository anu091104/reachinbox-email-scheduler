import { ChevronDown } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { Sender } from '../lib/api';
import clsx from 'clsx';

export function SenderSelect({ senders, value, onChange }: { senders: Sender[]; value: string; onChange: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const current = senders.find((s) => s.id === value);

  useEffect(() => {
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="inline-flex items-center gap-1.5 rounded-full bg-surface px-3 py-1 text-sm ring-1 ring-line hover:ring-muted/40"
      >
        {current ? current.email : senders.length ? 'Choose sender' : 'No senders available'}
        <ChevronDown size={14} className="text-muted" />
      </button>
      {open && senders.length > 0 && (
        <ul role="listbox" className="absolute left-0 z-20 mt-1 max-h-64 w-80 overflow-auto rounded-xl border border-line bg-white p-1 shadow-lg">
          {senders.map((s) => (
            <li key={s.id}>
              <button
                type="button"
                role="option"
                aria-selected={s.id === value}
                onClick={() => {
                  onChange(s.id);
                  setOpen(false);
                }}
                className={clsx('flex w-full flex-col rounded-lg px-3 py-2 text-left hover:bg-surface', s.id === value && 'bg-brand-50')}
              >
                <span className="text-sm font-medium">{s.label}</span>
                <span className="text-xs text-muted">{s.email}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
