import { Queue } from 'bullmq';
import { env } from '../config/env.js';
import { createRedis } from '../lib/redis.js';

export interface SendEmailJobData {
  emailId: string;
  /** Send slot reserved by the throttle on a previous run (epoch ms). */
  slot?: number;
}

/**
 * The queue is just a handle onto data that lives in Redis.
 * A "delayed job" is an entry in a Redis sorted set scored by its due time, so it
 * survives our Node process dying. With Redis persistence (AOF) enabled it also
 * survives Redis restarting.
 */
export const emailQueue = new Queue<SendEmailJobData, unknown, 'send-email'>(env.QUEUE_NAME, {
  connection: createRedis(),
  defaultJobOptions: {
    attempts: env.JOB_MAX_ATTEMPTS,
    backoff: { type: 'exponential', delay: env.JOB_BACKOFF_MS },
    removeOnComplete: { age: 7 * 24 * 3600, count: 10_000 },
    removeOnFail: { age: 30 * 24 * 3600 },
  },
});

export interface Schedulable {
  id: string;
  scheduledAt: Date;
}

/**
 * The email's database id doubles as the BullMQ job id.
 * BullMQ ignores `add` for a job id that already exists, so enqueueing the same
 * email twice (e.g. API retry, or the boot-time reconciler) can never create a
 * duplicate send.
 */
export async function enqueueEmails(rows: Schedulable[], now = Date.now()): Promise<void> {
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    await emailQueue.addBulk(
      slice.map((r) => ({
        name: 'send-email' as const,
        data: { emailId: r.id },
        opts: { jobId: r.id, delay: Math.max(0, r.scheduledAt.getTime() - now) },
      })),
    );
  }
}

export async function removeEmailJob(emailId: string): Promise<'removed' | 'missing' | 'locked'> {
  const job = await emailQueue.getJob(emailId);
  if (!job) return 'missing';
  try {
    await job.remove();
    return 'removed';
  } catch {
    // An active (locked) job cannot be removed: a worker is sending it right now.
    return 'locked';
  }
}
