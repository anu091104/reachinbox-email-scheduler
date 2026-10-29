import { and, asc, eq, inArray, lt, or, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { attachments, campaigns, emails, senders, type Email } from '../db/schema.js';

/**
 * All state transitions of an email row live here, so the rules are in one place:
 *
 *   scheduled ──claim──▶ processing ──▶ sent
 *       ▲                    │
 *       └──── retry/defer ───┘──▶ failed (after the last attempt)
 *   scheduled ──cancel──▶ cancelled
 */

export type ClaimResult =
  | { ok: true; email: Email }
  | { ok: false; reason: 'missing' | 'final' }
  | { ok: false; reason: 'leased'; lockedUntil: Date };

/**
 * Atomically take ownership of an email before sending it.
 * The UPDATE ... WHERE is a compare-and-set: Postgres row locking guarantees only
 * one worker can flip `scheduled -> processing`. An expired lease (worker crashed
 * mid-send) can be taken over.
 */
export async function claimEmail(emailId: string, leaseMs: number): Promise<ClaimResult> {
  const leaseUntil = new Date(Date.now() + leaseMs);
  const [claimed] = await db
    .update(emails)
    .set({
      status: 'processing',
      lockedUntil: leaseUntil,
      attempts: sql`${emails.attempts} + 1`,
    })
    .where(
      and(
        eq(emails.id, emailId),
        or(
          eq(emails.status, 'scheduled'),
          and(eq(emails.status, 'processing'), lt(emails.lockedUntil, sql`now()`)),
        ),
      ),
    )
    .returning();

  if (claimed) return { ok: true, email: claimed };

  const [current] = await db
    .select({ status: emails.status, lockedUntil: emails.lockedUntil })
    .from(emails)
    .where(eq(emails.id, emailId));
  if (!current) return { ok: false, reason: 'missing' };
  if (current.status === 'processing' && current.lockedUntil) {
    return { ok: false, reason: 'leased', lockedUntil: current.lockedUntil };
  }
  return { ok: false, reason: 'final' };
}

/** Undo a claim without counting it as an attempt (rate-limit deferral). */
export async function releaseClaim(emailId: string, newScheduledAt?: Date): Promise<void> {
  await db
    .update(emails)
    .set({
      status: 'scheduled',
      lockedUntil: null,
      attempts: sql`greatest(${emails.attempts} - 1, 0)`,
      ...(newScheduledAt ? { scheduledAt: newScheduledAt, deferrals: sql`${emails.deferrals} + 1` } : {}),
    })
    .where(and(eq(emails.id, emailId), eq(emails.status, 'processing')));
}

export async function markSent(emailId: string, info: { messageId: string; previewUrl: string | null }) {
  await db
    .update(emails)
    .set({
      status: 'sent',
      sentAt: new Date(),
      lockedUntil: null,
      lastError: null,
      messageId: info.messageId,
      previewUrl: info.previewUrl,
    })
    .where(eq(emails.id, emailId));
}

export async function markRetrying(emailId: string, error: string, nextAttemptAt: Date) {
  await db
    .update(emails)
    .set({ status: 'scheduled', lockedUntil: null, lastError: error, scheduledAt: nextAttemptAt })
    .where(eq(emails.id, emailId));
}

export async function markFailed(emailId: string, error: string) {
  await db
    .update(emails)
    .set({ status: 'failed', lockedUntil: null, lastError: error, sentAt: new Date() })
    .where(eq(emails.id, emailId));
}

/** Everything the worker needs to actually send one email. */
export async function loadSendContext(emailId: string) {
  const [row] = await db
    .select({ email: emails, sender: senders, hourlyLimit: campaigns.hourlyLimit })
    .from(emails)
    .innerJoin(senders, eq(senders.id, emails.senderId))
    .innerJoin(campaigns, eq(campaigns.id, emails.campaignId))
    .where(eq(emails.id, emailId));
  if (!row) return null;
  const files = await db
    .select({ filename: attachments.filename, contentType: attachments.contentType, data: attachments.data })
    .from(attachments)
    .where(eq(attachments.campaignId, row.email.campaignId));
  return { ...row, attachments: files };
}

/** Used at boot: anything still `scheduled` in Postgres must have a job in Redis. */
export async function* iterateSchedulable(batchSize = 1000) {
  let lastId: string | null = null;
  for (;;) {
    const conditions = [inArray(emails.status, ['scheduled'] as const)];
    if (lastId) conditions.push(sql`${emails.id} > ${lastId}`);
    const batch = await db
      .select({ id: emails.id, scheduledAt: emails.scheduledAt })
      .from(emails)
      .where(and(...conditions))
      .orderBy(asc(emails.id))
      .limit(batchSize);
    if (batch.length === 0) return;
    yield batch;
    lastId = batch[batch.length - 1]!.id;
  }
}

/** A worker died while holding a lease: put the email back so it can be re-claimed. */
export async function recoverExpiredLeases(): Promise<number> {
  const rows = await db
    .update(emails)
    .set({ status: 'scheduled', lockedUntil: null })
    .where(and(eq(emails.status, 'processing'), lt(emails.lockedUntil, sql`now()`)))
    .returning({ id: emails.id });
  return rows.length;
}
