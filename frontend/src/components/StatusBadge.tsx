import { AlertCircle, Clock, Loader2 } from 'lucide-react';
import type { EmailListItem } from '../lib/api';
import { badgeTime } from '../lib/format';

export function StatusBadge({ email }: { email: Pick<EmailListItem, 'status' | 'scheduledAt' | 'deferrals'> }) {
  switch (email.status) {
    case 'scheduled':
      return (
        <span
          title={email.deferrals > 0 ? 'Pushed to a later hour by the hourly sending limit' : 'Scheduled'}
          className="inline-flex shrink-0 items-center gap-1 rounded-full bg-amber-tag px-2 py-0.5 text-[11px] font-medium text-amber-ink"
        >
          <Clock size={12} />
          {badgeTime(email.scheduledAt)}
          {email.deferrals > 0 && <span className="ml-0.5 rounded bg-amber-ink/15 px-1 text-[10px]">rate-limited</span>}
        </span>
      );
    case 'processing':
      return (
        <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-sky-50 px-2 py-0.5 text-[11px] font-medium text-sky-700">
          <Loader2 size={12} className="animate-spin" /> Sending
        </span>
      );
    case 'sent':
      return <span className="inline-flex shrink-0 rounded-full bg-surface px-2 py-0.5 text-[11px] font-medium text-muted ring-1 ring-line">Sent</span>;
    case 'failed':
      return (
        <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-red-50 px-2 py-0.5 text-[11px] font-medium text-red-600">
          <AlertCircle size={12} /> Failed
        </span>
      );
    default:
      return <span className="inline-flex shrink-0 rounded-full bg-surface px-2 py-0.5 text-[11px] font-medium text-muted">Cancelled</span>;
  }
}
