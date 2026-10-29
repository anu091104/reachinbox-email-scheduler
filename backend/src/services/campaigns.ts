import { eq } from 'drizzle-orm';
import sanitizeHtml from 'sanitize-html';
import { db } from '../db/client.js';
import { attachments, campaigns, emails, senders } from '../db/schema.js';
import { badRequest, HttpError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { enqueueEmails } from '../queue/email-queue.js';
import { syncToSearch } from './search.js';

export interface NewCampaign {
  userId: string;
  senderId: string;
  recipients: string[];
  subject: string;
  bodyHtml: string;
  startAt: Date;
  delayBetweenSeconds: number;
  hourlyLimit: number;
  files: { originalname: string; mimetype: string; size: number; buffer: Buffer }[];
}

const SAFE_HTML: sanitizeHtml.IOptions = {
  allowedTags: sanitizeHtml.defaults.allowedTags.concat(['img', 'span', 'u', 's', 'h1', 'h2', 'h3']),
  allowedAttributes: {
    a: ['href', 'target', 'rel'],
    img: ['src', 'alt', 'width', 'height'],
    '*': ['style'],
  },
  allowedStyles: { '*': { 'text-align': [/^(left|right|center|justify)$/] } },
  allowedSchemes: ['http', 'https', 'mailto'],
};

/**
 * Turns one Compose submission into N individually scheduled emails.
 *
 * Email i is due at startAt + i * delay, so the "Delay between 2 emails" from
 * the form is baked into each job's own due time. Every email is its own job,
 * which means one bad address cannot hold up the rest.
 */
export async function createCampaign(input: NewCampaign) {
  const [sender] = await db.select().from(senders).where(eq(senders.id, input.senderId));
  if (!sender || !sender.isActive) throw badRequest('Unknown or inactive sender');

  const bodyHtml = sanitizeHtml(input.bodyHtml, SAFE_HTML);
  const delayMs = input.delayBetweenSeconds * 1000;
  const startMs = Math.max(input.startAt.getTime(), Date.now());

  const created = await db.transaction(async (tx) => {
    const [campaign] = await tx
      .insert(campaigns)
      .values({
        userId: input.userId,
        senderId: sender.id,
        subject: input.subject,
        bodyHtml,
        startAt: new Date(startMs),
        delayBetweenMs: delayMs,
        hourlyLimit: input.hourlyLimit,
        totalRecipients: input.recipients.length,
      })
      .returning();
    if (!campaign) throw new Error('campaign insert returned nothing');

    if (input.files.length) {
      await tx.insert(attachments).values(
        input.files.map((f) => ({
          campaignId: campaign.id,
          filename: f.originalname,
          contentType: f.mimetype || 'application/octet-stream',
          sizeBytes: f.size,
          data: f.buffer,
        })),
      );
    }

    const rows = [];
    const CHUNK = 1000;
    for (let i = 0; i < input.recipients.length; i += CHUNK) {
      const values = input.recipients.slice(i, i + CHUNK).map((recipient, j) => {
        const seq = i + j;
        // +seq ms keeps same-time emails in list order when the queue promotes them
        const due = new Date(startMs + seq * delayMs + (delayMs === 0 ? seq : 0));
        return {
          campaignId: campaign.id,
          userId: input.userId,
          senderId: sender.id,
          sequence: seq,
          recipient,
          subject: input.subject,
          bodyHtml,
          scheduledAt: due,
          requestedAt: due,
        };
      });
      rows.push(...(await tx.insert(emails).values(values).returning({ id: emails.id, scheduledAt: emails.scheduledAt })));
    }
    return { campaign, rows };
  });

  // Commit first, enqueue second. If Redis is down we roll the campaign back so the
  // user sees an honest error instead of emails that silently never go out.
  try {
    await enqueueEmails(created.rows);
  } catch (err) {
    logger.error({ err, campaignId: created.campaign.id }, 'enqueue failed, rolling back campaign');
    await db.delete(campaigns).where(eq(campaigns.id, created.campaign.id));
    throw new HttpError(503, 'Scheduler is temporarily unavailable, please try again');
  }

  void syncToSearch(created.rows.map((r) => r.id));

  return {
    id: created.campaign.id,
    scheduled: created.rows.length,
    firstSendAt: created.rows[0]?.scheduledAt ?? null,
    lastSendAt: created.rows.at(-1)?.scheduledAt ?? null,
  };
}
