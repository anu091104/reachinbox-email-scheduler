/** Thin typed client for the backend. Cookies carry the session, so every call sends credentials. */

const BASE = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, '') ?? '';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const isForm = init.body instanceof FormData;
  const res = await fetch(`${BASE}${path}`, {
    credentials: 'include',
    ...init,
    headers: { ...(isForm || !init.body ? {} : { 'Content-Type': 'application/json' }), ...init.headers },
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, (data as { error?: string }).error ?? res.statusText, (data as { details?: unknown }).details);
  return data as T;
}

const json = (body: unknown) => JSON.stringify(body);

// ---- Types -------------------------------------------------------------------

export interface User {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
}
export interface Sender {
  id: string;
  label: string;
  email: string;
}
export type EmailStatus = 'scheduled' | 'processing' | 'sent' | 'failed' | 'cancelled';
export type Tab = 'scheduled' | 'sent';

export interface EmailListItem {
  id: string;
  recipient: string;
  subject: string;
  snippet: string;
  status: EmailStatus;
  scheduledAt: string;
  requestedAt: string;
  sentAt: string | null;
  deferrals: number;
  attempts: number;
  lastError: string | null;
  starred: boolean;
  senderEmail: string;
}

export interface EmailDetail {
  email: EmailListItem & {
    campaignId: string;
    bodyHtml: string;
    previewUrl: string | null;
    messageId: string | null;
    senderLabel: string;
    sequence: number;
    createdAt: string;
  };
  campaign: { delayBetweenMs: number; hourlyLimit: number };
  attachments: { id: string; filename: string; contentType: string; sizeBytes: number }[];
}

export interface SearchHit {
  id: string;
  recipient: string;
  subject: string;
  snippet: string;
  status: EmailStatus;
  scheduledAt: string;
  sentAt: string | null;
}

export interface CampaignPayload {
  senderId: string;
  recipients: string[];
  subject: string;
  bodyHtml: string;
  startAt: string;
  delayBetweenSeconds: number;
  hourlyLimit: number;
}

// ---- Endpoints ---------------------------------------------------------------

export const api = {
  config: () => request<{ googleClientId: string | null }>('/api/auth/config'),
  me: () => request<{ user: User }>('/api/auth/me'),
  googleLogin: (token: { credential: string } | { accessToken: string }) =>
    request<{ user: User }>('/api/auth/google', { method: 'POST', body: json(token) }),
  login: (email: string, password: string) => request<{ user: User }>('/api/auth/login', { method: 'POST', body: json({ email, password }) }),
  register: (name: string, email: string, password: string) =>
    request<{ user: User }>('/api/auth/register', { method: 'POST', body: json({ name, email, password }) }),
  logout: () => request<void>('/api/auth/logout', { method: 'POST' }),

  senders: () => request<{ senders: Sender[] }>('/api/senders'),
  stats: () => request<{ scheduled: number; sent: number; failed: number; cancelled: number }>('/api/emails/stats'),
  emails: (tab: Tab, page = 1, starred = false) =>
    request<{ items: EmailListItem[]; total: number; page: number; pageSize: number }>(
      `/api/emails?tab=${tab}&page=${page}&pageSize=25${starred ? '&starred=true' : ''}`,
    ),
  email: (id: string) => request<EmailDetail>(`/api/emails/${id}`),
  star: (id: string, starred: boolean) => request<{ id: string; starred: boolean }>(`/api/emails/${id}/star`, { method: 'PATCH', body: json({ starred }) }),
  cancel: (id: string) => request<void>(`/api/emails/${id}`, { method: 'DELETE' }),
  search: (q: string, tab?: Tab) =>
    request<{ engine: 'elasticsearch' | 'postgres'; hits: SearchHit[] }>(`/api/search?q=${encodeURIComponent(q)}${tab ? `&tab=${tab}` : ''}`),
  createCampaign: (payload: CampaignPayload, files: File[]) => {
    const form = new FormData();
    form.append('payload', JSON.stringify(payload));
    files.forEach((f) => form.append('attachments', f));
    return request<{ id: string; scheduled: number; firstSendAt: string; lastSendAt: string }>('/api/campaigns', { method: 'POST', body: form });
  },
  attachmentUrl: (id: string) => `${BASE}/api/attachments/${id}`,
};
