import clsx from 'clsx';
import { AlertCircle, ArrowLeft, CheckCircle2, ChevronDown, Clock, ExternalLink, FileText, Loader2, Star, Trash2 } from 'lucide-react';
import { useNavigate, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import { Avatar } from '../components/Avatar';
import { useCancel, useEmail, useStar } from '../hooks/queries';
import { useAuth } from '../hooks/useAuth';
import { api, ApiError, type EmailDetail } from '../lib/api';
import { fileSize, longDate, shortDate } from '../lib/format';

function StatusBanner({ e }: { e: EmailDetail['email'] }) {
  if (e.status === 'scheduled' || e.status === 'processing') {
    return (
      <div className="flex items-start gap-2 rounded-lg bg-amber-tag px-4 py-3 text-sm text-amber-ink">
        {e.status === 'processing' ? <Loader2 size={16} className="mt-0.5 animate-spin" /> : <Clock size={16} className="mt-0.5" />}
        <div>
          <p className="font-medium">{e.status === 'processing' ? 'Sending now…' : `Scheduled for ${longDate(e.scheduledAt)}`}</p>
          {e.deferrals > 0 && (
            <p className="text-xs opacity-80">
              Originally {longDate(e.requestedAt)}; moved {e.deferrals}× by the hourly sending limit.
            </p>
          )}
          {e.lastError && <p className="text-xs opacity-80">Last attempt failed ({e.lastError}). Retrying automatically.</p>}
        </div>
      </div>
    );
  }
  if (e.status === 'sent') {
    return (
      <div className="flex items-center gap-2 rounded-lg bg-brand-50 px-4 py-3 text-sm text-brand-700">
        <CheckCircle2 size={16} />
        <span className="flex-1">Sent {e.sentAt ? longDate(e.sentAt) : ''}</span>
        {e.previewUrl && (
          <a href={e.previewUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs font-medium underline">
            View on Ethereal <ExternalLink size={12} />
          </a>
        )}
      </div>
    );
  }
  if (e.status === 'failed') {
    return (
      <div className="flex items-start gap-2 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">
        <AlertCircle size={16} className="mt-0.5" />
        <div>
          <p className="font-medium">Failed after {e.attempts} attempt{e.attempts === 1 ? '' : 's'}</p>
          {e.lastError && <p className="text-xs">{e.lastError}</p>}
        </div>
      </div>
    );
  }
  return <div className="rounded-lg bg-surface px-4 py-3 text-sm text-muted">This email was cancelled and will not be sent.</div>;
}

export function EmailDetailPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const detail = useEmail(id);
  const star = useStar();
  const cancel = useCancel();

  if (detail.isLoading) {
    return (
      <div className="flex h-full items-center justify-center text-muted">
        <Loader2 className="animate-spin" />
      </div>
    );
  }
  if (detail.error || !detail.data) {
    return <p className="p-10 text-sm text-red-600">{detail.error instanceof ApiError ? detail.error.message : 'Email not found'}</p>;
  }

  const { email: e, attachments, campaign } = detail.data;

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-line px-6 py-4">
        <button onClick={() => navigate(-1)} aria-label="Back" className="rounded-full p-1 text-muted hover:bg-surface hover:text-ink">
          <ArrowLeft size={18} />
        </button>
        <h1 className="min-w-0 flex-1 truncate text-base font-semibold">
          {e.subject} <span className="text-sm font-normal text-muted">| {e.id.slice(0, 8).toUpperCase()}</span>
        </h1>
        <button
          aria-label={e.starred ? 'Unstar' : 'Star'}
          onClick={() => star.mutate({ id: e.id, starred: !e.starred })}
          className={clsx('rounded-full p-2 hover:bg-surface', e.starred ? 'text-amber-400' : 'text-muted')}
        >
          <Star size={17} fill={e.starred ? 'currentColor' : 'none'} />
        </button>
        {e.status === 'scheduled' && (
          <button
            aria-label="Cancel scheduled email"
            title="Cancel scheduled email"
            disabled={cancel.isPending}
            onClick={() =>
              cancel.mutate(e.id, {
                onSuccess: () => toast.success('Email cancelled'),
                onError: (err) => toast.error((err as Error).message),
              })
            }
            className="rounded-full p-2 text-muted hover:bg-red-50 hover:text-red-600"
          >
            <Trash2 size={17} />
          </button>
        )}
        {user && <Avatar name={user.name} src={user.avatarUrl} size={30} />}
      </header>

      <div className="flex-1 overflow-y-auto px-10 py-6">
        <div className="mx-auto max-w-4xl space-y-6">
          <StatusBanner e={e} />

          <div className="flex items-start gap-3">
            <Avatar name={e.senderLabel} size={40} />
            <div className="min-w-0 flex-1">
              <p className="text-sm">
                <span className="font-semibold">{e.senderLabel}</span> <span className="text-muted">&lt;{e.senderEmail}&gt;</span>
              </p>
              <p className="inline-flex items-center gap-1 text-xs text-muted">
                to {e.recipient} <ChevronDown size={12} />
              </p>
            </div>
            <span className="shrink-0 text-xs text-muted">{shortDate(e.sentAt ?? e.scheduledAt)}</span>
          </div>

          {/* Body HTML was sanitised on the server before it was stored. */}
          <article className="prose-email text-sm leading-6" dangerouslySetInnerHTML={{ __html: e.bodyHtml }} />

          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-4 pt-2">
              {attachments.map((a) => (
                <a key={a.id} href={api.attachmentUrl(a.id)} target="_blank" rel="noreferrer" className="w-36">
                  <div className="flex h-24 items-center justify-center overflow-hidden rounded-lg bg-surface ring-1 ring-line">
                    {a.contentType.startsWith('image/') ? (
                      <img src={api.attachmentUrl(a.id)} alt={a.filename} className="h-full w-full object-cover" />
                    ) : (
                      <FileText className="text-muted" />
                    )}
                  </div>
                  <p className="mt-1 truncate text-xs">{a.filename}</p>
                  <p className="text-[11px] text-muted">{fileSize(a.sizeBytes)}</p>
                </a>
              ))}
            </div>
          )}

          <dl className="grid grid-cols-2 gap-x-6 gap-y-2 rounded-lg border border-line p-4 text-xs sm:grid-cols-4">
            <div>
              <dt className="text-muted">Attempts</dt>
              <dd className="font-medium">{e.attempts}</dd>
            </div>
            <div>
              <dt className="text-muted">Position in campaign</dt>
              <dd className="font-medium">#{e.sequence + 1}</dd>
            </div>
            <div>
              <dt className="text-muted">Delay between emails</dt>
              <dd className="font-medium">{campaign.delayBetweenMs / 1000}s</dd>
            </div>
            <div>
              <dt className="text-muted">Campaign hourly limit</dt>
              <dd className="font-medium">{campaign.hourlyLimit || 'None'}</dd>
            </div>
          </dl>
        </div>
      </div>
    </div>
  );
}
