import { addDays, format, set } from 'date-fns';
import { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';

const toLocalInput = (d: Date) => format(d, "yyyy-MM-dd'T'HH:mm");

function presets(now = new Date()) {
  const tomorrow = addDays(now, 1);
  const at = (h: number) => set(tomorrow, { hours: h, minutes: 0, seconds: 0, milliseconds: 0 });
  return [
    { label: 'Tomorrow', date: set(tomorrow, { seconds: 0, milliseconds: 0 }) },
    { label: 'Tomorrow, 10:00 AM', date: at(10) },
    { label: 'Tomorrow, 11:00 AM', date: at(11) },
    { label: 'Tomorrow, 3:00 PM', date: at(15) },
  ];
}

interface Props {
  value: Date | null;
  onDone: (d: Date) => void;
  onClose: () => void;
}

export function SendLaterPopover({ value, onDone, onClose }: Props) {
  const [draft, setDraft] = useState(value ? toLocalInput(value) : '');
  const [error, setError] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && onClose();
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('mousedown', handler);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', handler);
      document.removeEventListener('keydown', esc);
    };
  }, [onClose]);

  const done = () => {
    const d = new Date(draft);
    if (!draft || Number.isNaN(d.getTime())) return setError('Pick a date and time');
    if (d.getTime() < Date.now() - 60_000) return setError('That time is in the past');
    onDone(d);
  };

  return (
    <div ref={ref} role="dialog" aria-label="Send later" className="absolute top-full right-0 z-30 mt-2 w-72 rounded-xl border border-line bg-white p-4 shadow-xl">
      <h3 className="mb-3 text-sm font-semibold">Send Later</h3>
      <input
        type="datetime-local"
        value={draft}
        min={toLocalInput(new Date())}
        onChange={(e) => {
          setDraft(e.target.value);
          setError('');
        }}
        aria-label="Pick date & time"
        className="w-full rounded-lg border border-line px-3 py-2 text-sm outline-none focus:border-brand-600"
      />
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
      <ul className="mt-3 flex flex-col">
        {presets().map((p) => {
          const v = toLocalInput(p.date);
          return (
            <li key={p.label}>
              <button
                type="button"
                onClick={() => {
                  setDraft(v);
                  setError('');
                }}
                className={clsx('w-full rounded-md px-2 py-1.5 text-left text-sm hover:bg-surface', draft === v && 'bg-brand-50 font-medium')}
              >
                {p.label}
              </button>
            </li>
          );
        })}
      </ul>
      <div className="mt-4 flex items-center justify-end gap-3">
        <button type="button" onClick={onClose} className="text-sm text-muted hover:text-ink">
          Cancel
        </button>
        <button type="button" onClick={done} className="rounded-full border border-brand-600 px-4 py-1 text-sm font-medium text-brand-600 hover:bg-brand-50">
          Done
        </button>
      </div>
    </div>
  );
}
