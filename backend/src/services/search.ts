import { Client } from '@elastic/elasticsearch';
import { and, desc, eq, ilike, inArray, or } from 'drizzle-orm';
import sanitizeHtml from 'sanitize-html';
import { env } from '../config/env.js';
import { db } from '../db/client.js';
import { emails, senders, type EmailStatus } from '../db/schema.js';
import { logger } from '../lib/logger.js';

/**
 * Elasticsearch keeps a *copy* of each email, shaped for full-text search
 * (fuzzy matching, relevance ranking, highlighting). Postgres stays the source
 * of truth: if the index is ever lost, `npm run search:reindex` rebuilds it.
 */

const log = logger.child({ module: 'search' });
const INDEX = env.ELASTICSEARCH_INDEX;

export const es = env.ELASTICSEARCH_URL
  ? new Client({
      node: env.ELASTICSEARCH_URL,
      auth: env.ELASTICSEARCH_API_KEY ? { apiKey: env.ELASTICSEARCH_API_KEY } : undefined,
      requestTimeout: 5000,
      maxRetries: 2,
    })
  : null;

let ready = false;
export const searchEnabled = () => es !== null && ready;

export async function initSearch(): Promise<void> {
  if (!es) {
    log.warn('ELASTICSEARCH_URL not set: search will use the Postgres fallback');
    return;
  }
  try {
    const exists = await es.indices.exists({ index: INDEX });
    if (!exists) {
      await es.indices.create({
        index: INDEX,
        settings: {
          analysis: {
            analyzer: {
              email_addr: { type: 'custom', tokenizer: 'uax_url_email', filter: ['lowercase'] },
            },
          },
        },
        mappings: {
          dynamic: 'strict',
          properties: {
            id: { type: 'keyword' },
            userId: { type: 'keyword' },
            campaignId: { type: 'keyword' },
            recipient: {
              type: 'text',
              analyzer: 'standard',
              fields: { raw: { type: 'keyword' }, addr: { type: 'text', analyzer: 'email_addr' } },
            },
            senderEmail: { type: 'keyword' },
            subject: { type: 'text', fields: { raw: { type: 'keyword', ignore_above: 512 } } },
            body: { type: 'text' },
            status: { type: 'keyword' },
            scheduledAt: { type: 'date' },
            sentAt: { type: 'date' },
            createdAt: { type: 'date' },
          },
        },
      });
      log.info({ index: INDEX }, 'created search index');
    }
    ready = true;
  } catch (err) {
    log.error({ err }, 'elasticsearch unavailable: falling back to Postgres search');
  }
}

const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' };

/** HTML -> plain text for indexing and snippets (block tags become spaces, entities decoded). */
export const toText = (html: string) =>
  sanitizeHtml(html.replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|blockquote|pre)>/gi, ' '), { allowedTags: [], allowedAttributes: {} })
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (m) => ENTITIES[m] ?? m)
    .replace(/\s+/g, ' ')
    .trim();

/** Highlight markers: control characters can never appear in user text, so they are safe to split on. */
export const HL_START = '\u0002';
export const HL_END = '\u0003';

async function loadDocs(ids: string[]) {
  if (ids.length === 0) return [];
  const rows = await db
    .select({ e: emails, senderEmail: senders.email })
    .from(emails)
    .innerJoin(senders, eq(senders.id, emails.senderId))
    .where(inArray(emails.id, ids));
  return rows.map(({ e, senderEmail }) => ({
    id: e.id,
    userId: e.userId,
    campaignId: e.campaignId,
    recipient: e.recipient,
    senderEmail,
    subject: e.subject,
    body: toText(e.bodyHtml),
    status: e.status,
    scheduledAt: e.scheduledAt.toISOString(),
    sentAt: e.sentAt?.toISOString() ?? null,
    createdAt: e.createdAt.toISOString(),
  }));
}

/**
 * Index (or re-index) emails by id. Never throws: search is a secondary concern
 * and must not break scheduling or sending.
 */
export async function syncToSearch(ids: string[]): Promise<void> {
  if (!es || !ready || ids.length === 0) return;
  try {
    for (let i = 0; i < ids.length; i += 500) {
      const docs = await loadDocs(ids.slice(i, i + 500));
      const operations = docs.flatMap((d) => [{ index: { _index: INDEX, _id: d.id } }, d]);
      const res = await es.bulk({ operations, refresh: false });
      if (res.errors) log.warn({ items: res.items.filter((it) => it.index?.error).slice(0, 3) }, 'some documents failed to index');
    }
  } catch (err) {
    log.error({ err, count: ids.length }, 'failed to sync emails to search index');
  }
}

export interface SearchParams {
  userId: string;
  q: string;
  status?: EmailStatus[];
  limit: number;
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

export async function searchEmails(p: SearchParams): Promise<{ engine: 'elasticsearch' | 'postgres'; hits: SearchHit[] }> {
  if (es && ready) {
    try {
      const res = await es.search<{ id: string; recipient: string; subject: string; body: string; status: EmailStatus; scheduledAt: string; sentAt: string | null }>({
        index: INDEX,
        size: p.limit,
        query: {
          bool: {
            filter: [{ term: { userId: p.userId } }, ...(p.status?.length ? [{ terms: { status: p.status } }] : [])],
            should: [
              { multi_match: { query: p.q, fields: ['subject^3', 'recipient.addr^2', 'recipient^2', 'body'], fuzziness: 'AUTO' } },
              { multi_match: { query: p.q, type: 'phrase_prefix', fields: ['subject^3', 'recipient^2', 'body'] } },
            ],
            minimum_should_match: 1,
          },
        },
        highlight: { pre_tags: [HL_START], post_tags: [HL_END], fields: { body: { fragment_size: 140, number_of_fragments: 1 } } },
        sort: ['_score', { scheduledAt: 'desc' }],
      });
      return {
        engine: 'elasticsearch',
        hits: res.hits.hits.map((h) => {
          const s = h._source!;
          return {
            id: s.id,
            recipient: s.recipient,
            subject: s.subject,
            snippet: h.highlight?.body?.[0] ?? s.body.slice(0, 140),
            status: s.status,
            scheduledAt: s.scheduledAt,
            sentAt: s.sentAt,
          };
        }),
      };
    } catch (err) {
      log.error({ err }, 'elasticsearch query failed, using fallback');
    }
  }

  const term = `%${p.q.replace(/[%_]/g, '\\$&')}%`;
  const rows = await db
    .select()
    .from(emails)
    .where(
      and(
        eq(emails.userId, p.userId),
        p.status?.length ? inArray(emails.status, p.status) : undefined,
        or(ilike(emails.subject, term), ilike(emails.recipient, term), ilike(emails.bodyHtml, term)),
      ),
    )
    .orderBy(desc(emails.scheduledAt))
    .limit(p.limit);
  return {
    engine: 'postgres',
    hits: rows.map((e) => ({
      id: e.id,
      recipient: e.recipient,
      subject: e.subject,
      snippet: toText(e.bodyHtml).slice(0, 140),
      status: e.status,
      scheduledAt: e.scheduledAt.toISOString(),
      sentAt: e.sentAt?.toISOString() ?? null,
    })),
  };
}
