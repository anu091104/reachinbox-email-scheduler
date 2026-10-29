import { format, isThisYear, isToday, isTomorrow } from 'date-fns';

/** "Tue 9:15:12 AM" — the badge format used in the mailbox list. */
export const badgeTime = (iso: string) => format(new Date(iso), 'EEE h:mm:ss a');

export const shortDate = (iso: string) => {
  const d = new Date(iso);
  if (isToday(d)) return `Today, ${format(d, 'h:mm a')}`;
  if (isTomorrow(d)) return `Tomorrow, ${format(d, 'h:mm a')}`;
  return format(d, isThisYear(d) ? 'MMM d, h:mm a' : 'MMM d yyyy, h:mm a');
};

export const longDate = (iso: string) => format(new Date(iso), "EEE, MMM d yyyy 'at' h:mm:ss a");

export const nameFromEmail = (email: string) => {
  const local = email.split('@')[0] ?? email;
  return local
    .split(/[._-]+/)
    .filter(Boolean)
    .map((p) => p[0]!.toUpperCase() + p.slice(1))
    .join(' ');
};

export const initials = (nameOrEmail: string) =>
  nameOrEmail
    .split(/[\s@._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join('');

export const fileSize = (bytes: number) =>
  bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
