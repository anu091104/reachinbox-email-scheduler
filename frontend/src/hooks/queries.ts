import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type Tab } from '../lib/api';

// The mailbox refreshes itself every few seconds so scheduled -> sent is visible live.
const LIVE = 5000;

export const useStats = () => useQuery({ queryKey: ['stats'], queryFn: api.stats, refetchInterval: LIVE });
export const useSenders = () => useQuery({ queryKey: ['senders'], queryFn: () => api.senders().then((r) => r.senders), staleTime: 60_000 });
export const useEmails = (tab: Tab, page: number, starred: boolean) =>
  useQuery({ queryKey: ['emails', tab, page, starred], queryFn: () => api.emails(tab, page, starred), refetchInterval: LIVE, placeholderData: (prev) => prev });
export const useEmail = (id: string) => useQuery({ queryKey: ['email', id], queryFn: () => api.email(id), refetchInterval: LIVE });
export const useSearch = (q: string, tab: Tab) =>
  useQuery({ queryKey: ['search', tab, q], queryFn: () => api.search(q, tab), enabled: q.trim().length > 0, placeholderData: (prev) => prev });

export function useStar() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, starred }: { id: string; starred: boolean }) => api.star(id, starred),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['emails'] });
      void qc.invalidateQueries({ queryKey: ['email'] });
    },
  });
}

export function useCancel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.cancel(id),
    onSuccess: () => void qc.invalidateQueries(),
  });
}
