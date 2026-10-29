import { Upload, X } from 'lucide-react';
import { useRef, useState, type KeyboardEvent } from 'react';
import { toast } from 'sonner';
import { EMAIL_RE, extractEmails, readLeadFile } from '../lib/leads';

interface Props {
  value: string[];
  onChange: (emails: string[]) => void;
}

const VISIBLE = 3;

/**
 * "To" field: type addresses (Enter / comma / paste) or upload a CSV/TXT lead list.
 * Shows the first few as chips and collapses the rest into "+N", like the design.
 */
export function RecipientInput({ value, onChange }: Props) {
  const [draft, setDraft] = useState('');
  const [expanded, setExpanded] = useState(false);
  const [source, setSource] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const add = (list: string[]) => {
    const merged = [...new Set([...value, ...list.map((e) => e.toLowerCase())])];
    onChange(merged);
  };

  const commitDraft = () => {
    const found = extractEmails(draft);
    if (found.length) add(found);
    else if (draft.trim()) toast.error(`"${draft.trim()}" is not a valid email address`);
    setDraft('');
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (['Enter', ',', ' ', 'Tab'].includes(e.key) && draft.trim()) {
      if (e.key !== 'Tab') e.preventDefault();
      commitDraft();
    } else if (e.key === 'Backspace' && !draft && value.length) {
      onChange(value.slice(0, -1));
    }
  };

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      const emails = await readLeadFile(file);
      if (!emails.length) return toast.error(`No email addresses found in ${file.name}`);
      add(emails);
      setSource(file.name);
      toast.success(`${emails.length} email${emails.length === 1 ? '' : 's'} found in ${file.name}`);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const shown = expanded ? value : value.slice(0, VISIBLE);
  const hidden = value.length - shown.length;

  return (
    <div className="flex min-w-0 flex-1 items-start gap-3">
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
        {shown.map((email) => (
          <span
            key={email}
            className={
              'inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs ring-1 ' +
              (EMAIL_RE.test(email) ? 'bg-brand-50 text-brand-700 ring-brand-100' : 'bg-red-50 text-red-600 ring-red-200')
            }
          >
            {email}
            <button type="button" aria-label={`Remove ${email}`} onClick={() => onChange(value.filter((v) => v !== email))} className="opacity-60 hover:opacity-100">
              <X size={12} />
            </button>
          </span>
        ))}
        {hidden > 0 && (
          <button type="button" onClick={() => setExpanded(true)} className="rounded-full bg-brand-50 px-2.5 py-0.5 text-xs font-medium text-brand-700 ring-1 ring-brand-100">
            +{hidden}
          </button>
        )}
        {expanded && value.length > VISIBLE && (
          <button type="button" onClick={() => setExpanded(false)} className="text-xs text-muted underline">
            show less
          </button>
        )}
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKey}
          onBlur={() => draft.trim() && commitDraft()}
          onPaste={(e) => {
            const text = e.clipboardData.getData('text');
            const found = extractEmails(text);
            if (found.length > 1) {
              e.preventDefault();
              add(found);
            }
          }}
          placeholder={value.length ? '' : 'recipient@example.com'}
          aria-label="Recipients"
          className="min-w-[180px] flex-1 bg-transparent py-1 text-sm outline-none placeholder:text-muted/60"
        />
      </div>
      <div className="flex shrink-0 flex-col items-end">
        <button type="button" onClick={() => fileRef.current?.click()} className="inline-flex items-center gap-1 py-1 text-xs font-medium text-brand-600 hover:text-brand-700">
          <Upload size={13} /> Upload List
        </button>
        {value.length > 0 && (
          <span className="text-[11px] text-muted">
            {value.length} recipient{value.length === 1 ? '' : 's'}
            {source ? ` · ${source}` : ''}
          </span>
        )}
      </div>
      <input ref={fileRef} type="file" accept=".csv,.txt,text/csv,text/plain" hidden onChange={(e) => void onFile(e.target.files?.[0])} />
    </div>
  );
}
