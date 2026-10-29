import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Clock, FileText, Loader2, Paperclip, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { RecipientInput } from '../components/RecipientInput';
import { RichTextEditor } from '../components/RichTextEditor';
import { SendLaterPopover } from '../components/SendLaterPopover';
import { SenderSelect } from '../components/SenderSelect';
import { useSenders } from '../hooks/queries';
import { api, ApiError } from '../lib/api';
import { fileSize, shortDate } from '../lib/format';
import { EMAIL_RE } from '../lib/leads';

const MAX_FILES = 5;
const MAX_FILE_BYTES = 5 * 1024 * 1024;

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-4 border-b border-line py-3">
      <span className="w-16 shrink-0 pt-1 text-sm text-muted">{label}</span>
      {children}
    </div>
  );
}

function Thumb({ file, onRemove }: { file: File; onRemove: () => void }) {
  const url = useMemo(() => (file.type.startsWith('image/') ? URL.createObjectURL(file) : null), [file]);
  useEffect(() => () => void (url && URL.revokeObjectURL(url)), [url]);
  return (
    <div className="group relative w-28">
      <div className="flex h-20 items-center justify-center overflow-hidden rounded-lg bg-surface ring-1 ring-line">
        {url ? <img src={url} alt={file.name} className="h-full w-full object-cover" /> : <FileText className="text-muted" />}
      </div>
      <p className="mt-1 truncate text-[11px]" title={file.name}>
        {file.name}
      </p>
      <p className="text-[10px] text-muted">{fileSize(file.size)}</p>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${file.name}`}
        className="absolute -top-2 -right-2 rounded-full bg-white p-0.5 text-muted shadow ring-1 ring-line hover:text-red-600"
      >
        <X size={12} />
      </button>
    </div>
  );
}

export function ComposePage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const senders = useSenders();

  const [senderId, setSenderId] = useState('');
  const [recipients, setRecipients] = useState<string[]>([]);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState({ html: '', empty: true });
  const [delaySec, setDelaySec] = useState('');
  const [hourlyLimit, setHourlyLimit] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [sendAt, setSendAt] = useState<Date | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!senderId && senders.data?.[0]) setSenderId(senders.data[0].id);
  }, [senders.data, senderId]);

  const create = useMutation({
    mutationFn: () =>
      api.createCampaign(
        {
          senderId,
          recipients,
          subject: subject.trim(),
          bodyHtml: body.html,
          startAt: (sendAt ?? new Date()).toISOString(),
          delayBetweenSeconds: Number(delaySec || 0),
          hourlyLimit: Number(hourlyLimit || 0),
        },
        files,
      ),
    onSuccess: (r) => {
      void qc.invalidateQueries();
      toast.success(`${r.scheduled} email${r.scheduled === 1 ? '' : 's'} scheduled`, {
        description: r.scheduled > 1 ? `First at ${shortDate(r.firstSendAt)}, last at ${shortDate(r.lastSendAt)}` : `Sending ${shortDate(r.firstSendAt)}`,
      });
      navigate('/scheduled');
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not schedule emails'),
  });

  const problems = (() => {
    const p: string[] = [];
    if (!senderId) p.push('Choose a sender');
    if (!recipients.length) p.push('Add at least one recipient');
    if (recipients.some((r) => !EMAIL_RE.test(r))) p.push('Remove invalid recipients');
    if (!subject.trim()) p.push('Add a subject');
    if (body.empty) p.push('Write the email body');
    return p;
  })();

  const submit = () => {
    if (problems.length) return toast.error(problems[0]);
    create.mutate();
  };

  const addFiles = (list: FileList | null) => {
    if (!list) return;
    const next = [...files];
    for (const f of Array.from(list)) {
      if (f.size > MAX_FILE_BYTES) toast.error(`${f.name} is larger than 5 MB`);
      else if (next.length >= MAX_FILES) toast.error(`At most ${MAX_FILES} attachments`);
      else next.push(f);
    }
    setFiles(next);
    if (fileRef.current) fileRef.current.value = '';
  };

  const numeric = (set: (v: string) => void) => (e: React.ChangeEvent<HTMLInputElement>) => set(e.target.value.replace(/\D/g, '').slice(0, 6));

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-line px-6 py-4">
        <button onClick={() => navigate(-1)} aria-label="Back" className="rounded-full p-1 text-muted hover:bg-surface hover:text-ink">
          <ArrowLeft size={18} />
        </button>
        <h1 className="flex-1 text-base font-semibold">Compose New Email</h1>

        <button onClick={() => fileRef.current?.click()} aria-label="Attach files" title="Attach files" className="rounded-full p-2 text-muted hover:bg-surface hover:text-ink">
          <Paperclip size={17} />
        </button>
        <input ref={fileRef} type="file" multiple hidden onChange={(e) => addFiles(e.target.files)} />

        <div className="relative">
          <button
            onClick={() => setPickerOpen((v) => !v)}
            aria-label="Send later"
            title="Send later"
            className={'rounded-full p-2 hover:bg-surface ' + (sendAt ? 'text-brand-600' : 'text-muted hover:text-ink')}
          >
            <Clock size={17} />
          </button>
          {pickerOpen && (
            <SendLaterPopover
              value={sendAt}
              onClose={() => setPickerOpen(false)}
              onDone={(d) => {
                setSendAt(d);
                setPickerOpen(false);
              }}
            />
          )}
        </div>

        <button
          onClick={submit}
          disabled={create.isPending}
          className="inline-flex items-center gap-2 rounded-full border border-brand-600 px-5 py-1.5 text-sm font-semibold text-brand-600 transition hover:bg-brand-50 disabled:opacity-60"
        >
          {create.isPending && <Loader2 size={14} className="animate-spin" />}
          {sendAt ? 'Send Later' : 'Send'}
        </button>
      </header>

      <div className="flex-1 overflow-y-auto px-10 py-4">
        <div className="mx-auto max-w-4xl">
          {sendAt && (
            <div className="mb-2 inline-flex items-center gap-2 rounded-full bg-brand-50 px-3 py-1 text-xs text-brand-700">
              <Clock size={12} /> Starts {shortDate(sendAt.toISOString())}
              <button onClick={() => setSendAt(null)} aria-label="Send now instead" className="opacity-70 hover:opacity-100">
                <X size={12} />
              </button>
            </div>
          )}

          <Field label="From">
            {senders.isLoading ? <span className="pt-1 text-sm text-muted">Loading…</span> : <SenderSelect senders={senders.data ?? []} value={senderId} onChange={setSenderId} />}
          </Field>

          <Field label="To">
            <RecipientInput value={recipients} onChange={setRecipients} />
          </Field>

          <Field label="Subject">
            <input
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              maxLength={300}
              placeholder="Subject"
              className="flex-1 bg-transparent py-1 text-sm outline-none placeholder:text-muted/60"
            />
          </Field>

          <div className="flex flex-wrap items-center gap-8 py-4">
            <label className="flex items-center gap-3 text-sm text-muted">
              Delay between 2 emails
              <input
                inputMode="numeric"
                value={delaySec}
                onChange={numeric(setDelaySec)}
                placeholder="00"
                aria-describedby="delay-hint"
                className="w-16 rounded-md bg-surface px-2 py-1 text-center text-ink outline-none ring-1 ring-line focus:ring-brand-600"
              />
              <span id="delay-hint" className="text-xs">
                sec
              </span>
            </label>
            <label className="flex items-center gap-3 text-sm text-muted">
              Hourly Limit
              <input
                inputMode="numeric"
                value={hourlyLimit}
                onChange={numeric(setHourlyLimit)}
                placeholder="00"
                className="w-16 rounded-md bg-surface px-2 py-1 text-center text-ink outline-none ring-1 ring-line focus:ring-brand-600"
              />
              <span className="text-xs">emails / hr (0 = no limit)</span>
            </label>
          </div>

          <RichTextEditor onChange={(html, empty) => setBody({ html, empty })} />

          {files.length > 0 && (
            <div className="mt-5 flex flex-wrap gap-4">
              {files.map((f, i) => (
                <Thumb key={`${f.name}-${i}`} file={f} onRemove={() => setFiles(files.filter((_, j) => j !== i))} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
