import clsx from 'clsx';
import { ChevronLeft, ChevronRight, Filter, Inbox, Loader2, RefreshCw, Search, Send } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { EmailRow } from '../components/EmailRow';
import { useEmails, useSearch } from '../hooks/queries';
import type { Tab } from '../lib/api';

function useDebounced<T>(value: T, ms = 300) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

function Empty({ tab, searching }: { tab: Tab; searching: boolean }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-24 text-center">
      <div className="rounded-full bg-surface p-4 text-muted">{tab === 'scheduled' ? <Inbox /> : <Send />}</div>
      <p className="text-sm font-medium">{searching ? 'No emails match your search' : tab === 'scheduled' ? 'Nothing scheduled right now' : 'No emails sent yet'}</p>
      {!searching && tab === 'scheduled' && (
        <Link to="/compose" className="rounded-full border border-brand-600 px-4 py-1.5 text-sm font-medium text-brand-600 hover:bg-brand-50">
          Compose an email
        </Link>
      )}
    </div>
  );
}

function SkeletonRows() {
  return (
    <ul aria-busy="true" aria-label="Loading emails">
      {Array.from({ length: 8 }).map((_, i) => (
        <li key={i} className="flex items-center gap-4 border-b border-line px-5 py-3.5">
          <span className="h-3 w-32 animate-pulse rounded bg-surface" />
          <span className="h-4 w-28 animate-pulse rounded-full bg-surface" />
          <span className="h-3 flex-1 animate-pulse rounded bg-surface" />
        </li>
      ))}
    </ul>
  );
}

export function MailboxPage({ tab }: { tab: Tab }) {
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [starredOnly, setStarredOnly] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const filterRef = useRef<HTMLDivElement>(null);
  const q = useDebounced(query.trim());

  useEffect(() => setPage(1), [tab, starredOnly]);
  useEffect(() => {
    const close = (e: MouseEvent) => filterRef.current && !filterRef.current.contains(e.target as Node) && setFilterOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  const list = useEmails(tab, page, starredOnly);
  const search = useSearch(q, tab);
  const searching = q.length > 0;

  const rows = searching ? (search.data?.hits ?? []) : (list.data?.items ?? []);
  const loading = searching ? search.isLoading : list.isLoading;
  const fetching = searching ? search.isFetching : list.isFetching;
  const error = searching ? search.error : list.error;
  const totalPages = list.data ? Math.max(1, Math.ceil(list.data.total / list.data.pageSize)) : 1;

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 px-5 py-4">
        <label className="flex flex-1 items-center gap-2 rounded-lg bg-surface px-3 py-2 ring-1 ring-transparent focus-within:ring-brand-600">
          <Search size={16} className="text-muted" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search"
            aria-label={`Search ${tab} emails`}
            className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted"
          />
          {searching && search.data && (
            <span className="text-[10px] tracking-wide text-muted uppercase" title="Search backend">
              {search.data.engine}
            </span>
          )}
        </label>

        <div className="relative" ref={filterRef}>
          <button
            onClick={() => setFilterOpen((v) => !v)}
            aria-label="Filter"
            className={clsx('rounded-lg p-2 hover:bg-surface', starredOnly ? 'text-brand-600' : 'text-muted')}
          >
            <Filter size={17} />
          </button>
          {filterOpen && (
            <div className="absolute right-0 z-20 mt-1 w-40 rounded-xl border border-line bg-white p-1 shadow-lg">
              {[
                { label: 'All emails', value: false },
                { label: 'Starred only', value: true },
              ].map((o) => (
                <button
                  key={o.label}
                  onClick={() => {
                    setStarredOnly(o.value);
                    setFilterOpen(false);
                  }}
                  className={clsx('w-full rounded-lg px-3 py-2 text-left text-sm hover:bg-surface', starredOnly === o.value && 'font-semibold text-brand-700')}
                >
                  {o.label}
                </button>
              ))}
            </div>
          )}
        </div>

        <button
          onClick={() => (searching ? search.refetch() : list.refetch())}
          aria-label="Refresh"
          className="rounded-lg p-2 text-muted hover:bg-surface hover:text-ink"
        >
          <RefreshCw size={17} className={clsx(fetching && 'animate-spin')} />
        </button>
      </header>

      <div className="flex-1 overflow-y-auto border-t border-line">
        {loading ? (
          <SkeletonRows />
        ) : error ? (
          <p className="py-24 text-center text-sm text-red-600">Could not load emails: {(error as Error).message}</p>
        ) : rows.length === 0 ? (
          <Empty tab={tab} searching={searching} />
        ) : (
          <ul>
            {rows.map((e) => (
              <EmailRow key={e.id} email={e} />
            ))}
          </ul>
        )}
      </div>

      {!searching && list.data && list.data.total > list.data.pageSize && (
        <footer className="flex items-center justify-end gap-3 border-t border-line px-5 py-2 text-xs text-muted">
          {fetching && <Loader2 size={12} className="animate-spin" />}
          <span>
            Page {page} of {totalPages} · {list.data.total} emails
          </span>
          <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)} aria-label="Previous page" className="rounded p-1 hover:bg-surface disabled:opacity-30">
            <ChevronLeft size={16} />
          </button>
          <button disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)} aria-label="Next page" className="rounded p-1 hover:bg-surface disabled:opacity-30">
            <ChevronRight size={16} />
          </button>
        </footer>
      )}
    </div>
  );
}
