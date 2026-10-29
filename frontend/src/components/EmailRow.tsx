import clsx from 'clsx';
import { Star } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useStar } from '../hooks/queries';
import type { EmailListItem } from '../lib/api';
import { nameFromEmail } from '../lib/format';
import { Highlight } from './Highlight';
import { StatusBadge } from './StatusBadge';

type Row = Pick<EmailListItem, 'id' | 'recipient' | 'subject' | 'snippet' | 'status' | 'scheduledAt'> &
  Partial<Pick<EmailListItem, 'deferrals' | 'starred'>>;

export function EmailRow({ email }: { email: Row }) {
  const star = useStar();
  const starred = email.starred ?? false;
  return (
    <li className="group border-b border-line last:border-b-0">
      <Link to={`/emails/${email.id}`} className="flex items-center gap-4 px-5 py-3 hover:bg-surface">
        <span className="w-40 shrink-0 truncate text-sm" title={email.recipient}>
          <span className="text-muted">To: </span>
          <span className="font-medium">{nameFromEmail(email.recipient)}</span>
        </span>
        <StatusBadge email={{ ...email, deferrals: email.deferrals ?? 0 }} />
        <span className="min-w-0 flex-1 truncate text-sm">
          <span className="font-semibold">{email.subject}</span>
          {email.snippet && (
            <span className="text-muted">
              {' '}
              - <Highlight text={email.snippet} />
            </span>
          )}
        </span>
        {email.starred !== undefined && (
          <button
            aria-label={starred ? 'Unstar' : 'Star'}
            onClick={(e) => {
              e.preventDefault();
              star.mutate({ id: email.id, starred: !starred });
            }}
            className={clsx('rounded p-1 transition', starred ? 'text-amber-400' : 'text-line group-hover:text-muted')}
          >
            <Star size={16} fill={starred ? 'currentColor' : 'none'} />
          </button>
        )}
      </Link>
    </li>
  );
}
