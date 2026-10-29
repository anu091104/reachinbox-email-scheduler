import clsx from 'clsx';
import { initials } from '../lib/format';

export function Avatar({ name, src, size = 32, className }: { name: string; src?: string | null; size?: number; className?: string }) {
  const style = { width: size, height: size, fontSize: Math.max(10, size * 0.38) };
  if (src) {
    return <img src={src} alt={name} referrerPolicy="no-referrer" style={style} className={clsx('shrink-0 rounded-full object-cover', className)} />;
  }
  return (
    <span style={style} className={clsx('inline-flex shrink-0 items-center justify-center rounded-full bg-brand-600 font-semibold text-white', className)}>
      {initials(name)}
    </span>
  );
}
