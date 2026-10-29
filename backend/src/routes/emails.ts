import { Router } from 'express';
import multer from 'multer';
import { and, asc, count, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { attachments, campaigns, emails, senders } from '../db/schema.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { currentUser, requireAuth } from '../middleware/auth.js';
import { removeEmailJob } from '../queue/email-queue.js';
import { throttle } from '../queue/send-worker.js';
import { createCampaign } from '../services/campaigns.js';
import { searchEmails, syncToSearch } from '../services/search.js';

export const apiRouter = Router();
apiRouter.use(requireAuth);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { files: 5, fileSize: 5 * 1024 * 1024 },
});

const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]{2,}$/;

const campaignInput = z.object({
  senderId: z.string().uuid(),
  recipients: z
    .array(z.string().trim().toLowerCase())
    .min(1, 'Add at least one recipient')
    .max(10_000, 'At most 10,000 recipients per campaign')
    .transform((list) => [...new Set(list)])
    .refine((list) => list.every((e) => EMAIL_RE.test(e)), { message: 'One or more recipient addresses are invalid' }),
  subject: z.string().trim().min(1, 'Subject is required').max(300),
  bodyHtml: z.string().min(1, 'Email body is required').max(200_000),
  startAt: z.coerce.date().refine((d) => d.getTime() > Date.now() - 5 * 60_000, 'Start time is in the past'),
  delayBetweenSeconds: z.coerce.number().int().min(0).max(24 * 3600).default(0),
  hourlyLimit: z.coerce.number().int().min(0).max(100_000).default(0),
});

// ---- Senders ------------------------------------------------------------------

apiRouter.get('/senders', async (_req, res) => {
  const rows = await db
    .select({ id: senders.id, label: senders.label, email: senders.email })
    .from(senders)
    .where(eq(senders.isActive, true))
    .orderBy(asc(senders.createdAt));
  res.json({ senders: rows });
});

// ---- Campaigns (Compose) ------------------------------------------------------

/**
 * multipart/form-data:
 *   payload      -> JSON string matching `campaignInput`
 *   attachments  -> 0..5 files (5 MB each)
 */
apiRouter.post('/campaigns', upload.array('attachments', 5), async (req, res) => {
  let raw: unknown = req.body;
  if (typeof req.body?.payload === 'string') {
    try {
      raw = JSON.parse(req.body.payload);
    } catch {
      throw badRequest('payload must be valid JSON');
    }
  }
  const input = campaignInput.parse(raw);
  const files = (req.files as Express.Multer.File[] | undefined) ?? [];
  const result = await createCampaign({ ...input, userId: currentUser(req).id, files });
  res.status(201).json(result);
});

// ---- Emails -------------------------------------------------------------------

const TABS = {
  scheduled: ['scheduled', 'processing'] as const,
  sent: ['sent', 'failed'] as const,
};

const listQuery = z.object({
  tab: z.enum(['scheduled', 'sent']).default('scheduled'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  starred: z.enum(['true', 'false']).optional(),
});

apiRouter.get('/emails', async (req, res) => {
  const q = listQuery.parse(req.query);
  const userId = currentUser(req).id;
  const where = and(
    eq(emails.userId, userId),
    inArray(emails.status, [...TABS[q.tab]]),
    q.starred === 'true' ? eq(emails.starred, true) : undefined,
  );
  const order = q.tab === 'scheduled' ? [asc(emails.scheduledAt), asc(emails.sequence)] : [desc(emails.sentAt)];

  const [rows, [total]] = await Promise.all([
    db
      .select({
        id: emails.id,
        recipient: emails.recipient,
        subject: emails.subject,
        snippet: sql<string>`left(regexp_replace(replace(replace(${emails.bodyHtml}, '&nbsp;', ' '), '&amp;', '&'), '<[^>]*>', ' ', 'g'), 160)`,
        status: emails.status,
        scheduledAt: emails.scheduledAt,
        requestedAt: emails.requestedAt,
        sentAt: emails.sentAt,
        deferrals: emails.deferrals,
        attempts: emails.attempts,
        lastError: emails.lastError,
        starred: emails.starred,
        senderEmail: senders.email,
      })
      .from(emails)
      .innerJoin(senders, eq(senders.id, emails.senderId))
      .where(where)
      .orderBy(...order)
      .limit(q.pageSize)
      .offset((q.page - 1) * q.pageSize),
    db.select({ n: count() }).from(emails).where(where),
  ]);

  res.json({
    items: rows.map((r) => ({ ...r, snippet: r.snippet.replace(/\s+/g, ' ').trim() })),
    page: q.page,
    pageSize: q.pageSize,
    total: total?.n ?? 0,
  });
});

apiRouter.get('/emails/stats', async (req, res) => {
  const userId = currentUser(req).id;
  const rows = await db
    .select({ status: emails.status, n: count() })
    .from(emails)
    .where(eq(emails.userId, userId))
    .groupBy(emails.status);
  const by = Object.fromEntries(rows.map((r) => [r.status, r.n])) as Record<string, number>;
  res.json({
    scheduled: (by.scheduled ?? 0) + (by.processing ?? 0),
    sent: by.sent ?? 0,
    failed: by.failed ?? 0,
    cancelled: by.cancelled ?? 0,
  });
});

apiRouter.get('/emails/:id', async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const [row] = await db
    .select({ email: emails, senderEmail: senders.email, senderLabel: senders.label, delayBetweenMs: campaigns.delayBetweenMs, hourlyLimit: campaigns.hourlyLimit })
    .from(emails)
    .innerJoin(senders, eq(senders.id, emails.senderId))
    .innerJoin(campaigns, eq(campaigns.id, emails.campaignId))
    .where(and(eq(emails.id, id), eq(emails.userId, currentUser(req).id)));
  if (!row) throw notFound('Email not found');

  const files = await db
    .select({ id: attachments.id, filename: attachments.filename, contentType: attachments.contentType, sizeBytes: attachments.sizeBytes })
    .from(attachments)
    .where(eq(attachments.campaignId, row.email.campaignId));

  const { lockedUntil: _l, ...email } = row.email;
  res.json({
    email: { ...email, senderEmail: row.senderEmail, senderLabel: row.senderLabel },
    campaign: { delayBetweenMs: row.delayBetweenMs, hourlyLimit: row.hourlyLimit },
    attachments: files,
  });
});

apiRouter.patch('/emails/:id/star', async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const { starred } = z.object({ starred: z.boolean() }).parse(req.body);
  const [row] = await db
    .update(emails)
    .set({ starred })
    .where(and(eq(emails.id, id), eq(emails.userId, currentUser(req).id)))
    .returning({ id: emails.id, starred: emails.starred });
  if (!row) throw notFound('Email not found');
  res.json(row);
});

/** Cancel a scheduled email: remove its delayed job and mark the row. */
apiRouter.delete('/emails/:id', async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const [row] = await db
    .select({ status: emails.status })
    .from(emails)
    .where(and(eq(emails.id, id), eq(emails.userId, currentUser(req).id)));
  if (!row) throw notFound('Email not found');
  if (row.status !== 'scheduled') throw conflict(`Only scheduled emails can be cancelled (this one is ${row.status})`);

  // Flip the row first: even if the job fires a millisecond later, the worker's
  // claim (status = 'scheduled') fails and nothing is sent.
  const [updated] = await db
    .update(emails)
    .set({ status: 'cancelled' })
    .where(and(eq(emails.id, id), eq(emails.status, 'scheduled')))
    .returning({ id: emails.id });
  if (!updated) throw conflict('This email is being sent right now');
  await removeEmailJob(id);
  void syncToSearch([id]);
  res.status(204).end();
});

apiRouter.get('/attachments/:id', async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const [file] = await db
    .select({ filename: attachments.filename, contentType: attachments.contentType, data: attachments.data })
    .from(attachments)
    .innerJoin(campaigns, eq(campaigns.id, attachments.campaignId))
    .where(and(eq(attachments.id, id), eq(campaigns.userId, currentUser(req).id)));
  if (!file) throw notFound('Attachment not found');
  res.setHeader('Content-Type', file.contentType);
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(file.filename)}"`);
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.send(file.data);
});

// ---- Search (Elasticsearch) ---------------------------------------------------

apiRouter.get('/search', async (req, res) => {
  const q = z
    .object({
      q: z.string().trim().min(1).max(200),
      tab: z.enum(['scheduled', 'sent']).optional(),
      limit: z.coerce.number().int().min(1).max(50).default(20),
    })
    .parse(req.query);
  const result = await searchEmails({
    userId: currentUser(req).id,
    q: q.q,
    status: q.tab ? [...TABS[q.tab]] : undefined,
    limit: q.limit,
  });
  res.json(result);
});

// ---- Throughput snapshot -----------------------------------------------------

apiRouter.get('/limits', async (_req, res) => {
  const rows = await db.select({ id: senders.id, email: senders.email }).from(senders);
  const usage = await throttle.usage(rows.map((r) => r.id));
  res.json({
    ...usage,
    senders: usage.senders.map((s) => ({ ...s, email: rows.find((r) => r.id === s.senderId)?.email })),
  });
});
