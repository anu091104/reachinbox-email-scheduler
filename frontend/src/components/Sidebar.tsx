import clsx from 'clsx';
import { ChevronDown, Clock3, LogOut, Send } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { useStats } from '../hooks/queries';
import { Avatar } from './Avatar';

export function Sidebar() {
  const { user, logout } = useAuth();
  const stats = useStats();
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const close = (e: MouseEvent) => menuRef.current && !menuRef.current.contains(e.target as Node) && setMenuOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  if (!user) return null;

  const items = [
    { to: '/scheduled', label: 'Scheduled', icon: Clock3, count: stats.data?.scheduled },
    { to: '/sent', label: 'Sent', icon: Send, count: stats.data ? stats.data.sent + stats.data.failed : undefined },
  ];

  return (
    <aside className="flex w-64 shrink-0 flex-col gap-5 border-r border-line px-4 py-5">
      <div className="px-1 text-2xl font-extrabold tracking-tight">ONB</div>

      <div className="relative" ref={menuRef}>
        <button
          onClick={() => setMenuOpen((v) => !v)}
          className="flex w-full items-center gap-2.5 rounded-xl bg-surface px-3 py-2.5 text-left hover:bg-line/60"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
        >
          <Avatar name={user.name} src={user.avatarUrl} size={34} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-semibold">{user.name}</span>
            <span className="block truncate text-xs text-muted">{user.email}</span>
          </span>
          <ChevronDown size={16} className={clsx('text-muted transition', menuOpen && 'rotate-180')} />
        </button>
        {menuOpen && (
          <div role="menu" className="absolute inset-x-0 top-full z-20 mt-1 rounded-xl border border-line bg-white p-1 shadow-lg">
            <button
              role="menuitem"
              onClick={async () => {
                await logout();
                navigate('/login', { replace: true });
              }}
              className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-red-600 hover:bg-red-50"
            >
              <LogOut size={15} /> Log out
            </button>
          </div>
        )}
      </div>

      <NavLink
        to="/compose"
        className="rounded-full border border-brand-600 py-2 text-center text-sm font-semibold text-brand-600 transition hover:bg-brand-50"
      >
        Compose
      </NavLink>

      <nav className="flex flex-col gap-1">
        <p className="px-2 pb-1 text-[11px] font-semibold tracking-wider text-muted uppercase">Core</p>
        {items.map(({ to, label, icon: Icon, count }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) =>
              clsx(
                'flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition',
                isActive ? 'bg-brand-50 font-semibold text-ink' : 'text-muted hover:bg-surface',
              )
            }
          >
            <Icon size={16} />
            <span className="flex-1">{label}</span>
            <span className="text-xs tabular-nums text-muted">{count ?? '–'}</span>
          </NavLink>
        ))}
      </nav>
    </aside>
  );
}
