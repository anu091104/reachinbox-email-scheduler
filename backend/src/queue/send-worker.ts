import { DelayedError, UnrecoverableError, Worker, type Job } from 'bullmq';
import { env } from '../config/env.js';
import { createRedis, redis } from '../lib/redis.js';
import { logger } from '../lib/logger.js';
import { deliver, isPermanentSmtpError } from '../services/mailer.js';
import { syncToSearch } from '../services/search.js';
import * as repo from '../services/email-repository.js';
import { emailQueue, enqueueEmails, type SendEmailJobData } from './email-queue.js';
import { SendThrottle } from './throttle.js';

const log = logger.child({ module: 'worker' });

export const throttle = new SendThrottle(redis, {
  minGapMs: env.MIN_DELAY_BETWEEN_EMAILS_MS,
  gapScope: env.SEND_GAP_SCOPE,
  perHourGlobal: env.MAX_EMAILS_PER_HOUR,
  perHourPerSender: env.MAX_EMAILS_PER_HOUR_PER_SENDER,
});

const jitter = (max = 300) => Math.floor(Math.random() * max);
const describe = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 1000);

/** Put the job back into the delayed set without burning one of its attempts. */
async function postpone(job: Job, token: string | undefined, runAt: number): Promise<never> {
  await job.moveToDelayed(runAt, token);
  throw new DelayedError();
}

/**
 * The life of one job:
 *   1. claim the row in Postgres (only one worker can win)
 *   2. ask the Redis throttle for permission (gap + hourly caps)
 *   3. talk to SMTP
 *   4. record the outcome
 */
export async function processSendJob(job: Job<SendEmailJobData>, token?: string) {
  const { emailId } = job.data;

  const claim = await repo.claimEmail(emailId, env.SEND_LEASE_MS);
  if (!claim.ok) {
    if (claim.reason === 'leased') {
      // Another worker (or a crashed one whose lease has not expired yet) owns it.
      return postpone(job, token, claim.lockedUntil.getTime() + 1000 + jitter());
    }
    log.debug({ emailId, reason: claim.reason }, 'nothing to do for job');
    return { skipped: claim.reason };
  }

  const ctx = await repo.loadSendContext(emailId);
  if (!ctx) return { skipped: 'missing' };

  const decision = await throttle.acquire({
    senderId: ctx.sender.id,
    campaignId: ctx.email.campaignId,
    campaignHourlyLimit: ctx.hourlyLimit,
    heldSlot: job.data.slot,
  });

  if (decision.kind === 'wait') {
    // We now own a future send slot; remember it on the job and sleep until then.
    await repo.releaseClaim(emailId);
    await job.updateData({ emailId, slot: decision.slotAt });
    return postpone(job, token, decision.slotAt);
  }

  if (decision.kind === 'defer') {
    const runAt = new Date(decision.runAt);
    await repo.releaseClaim(emailId, runAt);
    await job.updateData({ emailId });
    void syncToSearch([emailId]);
    log.info({ emailId, rule: decision.rule, runAt: runAt.toISOString() }, 'hourly limit reached, deferred to next window');
    return postpone(job, token, decision.runAt);
  }

  try {
    const result = await deliver({
      emailId,
      sender: ctx.sender,
      to: ctx.email.recipient,
      subject: ctx.email.subject,
      html: ctx.email.bodyHtml,
      attachments: ctx.attachments,
    });
    await repo.markSent(emailId, result);
    void syncToSearch([emailId]);
    log.info({ emailId, to: ctx.email.recipient, from: ctx.sender.email, preview: result.previewUrl }, 'email sent');
    return result;
  } catch (err) {
    const message = describe(err);
    const permanent = isPermanentSmtpError(err);
    const lastAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);

    if (permanent || lastAttempt) {
      await repo.markFailed(emailId, message);
      void syncToSearch([emailId]);
      log.error({ emailId, err: message, permanent }, 'email failed permanently');
      throw new UnrecoverableError(message);
    }

    // Nothing left the building: hand the hourly slot back and let BullMQ retry with backoff.
    await decision.release();
    const backoff = env.JOB_BACKOFF_MS * 2 ** job.attemptsMade;
    await repo.markRetrying(emailId, message, new Date(Date.now() + backoff));
    void syncToSearch([emailId]);
    log.warn({ emailId, err: message, attempt: job.attemptsMade + 1 }, 'send failed, will retry');
    throw err;
  }
}

/**
 * Self-healing at boot. Postgres is the source of truth; Redis holds the timers.
 * If they ever disagree (Redis volume wiped, a crash between DB commit and enqueue),
 * every email still marked `scheduled` gets its job re-created. Thanks to
 * jobId = emailId this is a no-op for jobs that already exist.
 */
export async function reconcileOnBoot(): Promise<void> {
  const recovered = await repo.recoverExpiredLeases();
  let total = 0;
  for await (const batch of repo.iterateSchedulable()) {
    await enqueueEmails(batch);
    total += batch.length;
  }
  const counts = await emailQueue.getJobCounts('delayed', 'waiting', 'active');
  log.info({ recoveredLeases: recovered, scheduledInDb: total, queue: counts }, 'boot reconciliation complete');
}

export function startWorker(): Worker<SendEmailJobData> {
  const worker = new Worker<SendEmailJobData>(env.QUEUE_NAME, processSendJob, {
    connection: createRedis(),
    concurrency: env.WORKER_CONCURRENCY,
    // If a worker process dies, its jobs' locks expire and another worker picks them up.
    lockDuration: 30_000,
    stalledInterval: 30_000,
    maxStalledCount: 3,
  });

  worker.on('ready', () => log.info({ concurrency: env.WORKER_CONCURRENCY }, 'worker ready'));
  worker.on('failed', (job, err) => {
    if (job) log.debug({ jobId: job.id, err: err.message }, 'job attempt failed');
  });
  worker.on('error', (err) => log.error({ err }, 'worker error'));
  return worker;
}
