import type { Server } from 'node:http';
import type { Worker } from 'bullmq';
import { env } from './config/env.js';
import { pool } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { logger } from './lib/logger.js';
import { redis } from './lib/redis.js';
import { emailQueue } from './queue/email-queue.js';
import { reconcileOnBoot, startWorker } from './queue/send-worker.js';
import { closeTransports, ensureSenders } from './services/mailer.js';
import { initSearch } from './services/search.js';

export type Role = 'api' | 'worker' | 'all';

/**
 * One codebase, three ways to run it:
 *   all    -> API + worker in one process (simplest; good for local dev and small deploys)
 *   api    -> only HTTP
 *   worker -> only sending; start as many of these as you like, they coordinate through Redis
 */
export async function start(role: Role) {
  logger.info({ role, env: env.NODE_ENV }, 'starting');
  await runMigrations();
  await initSearch();

  let server: Server | undefined;
  let worker: Worker | undefined;

  if (role !== 'worker') {
    await ensureSenders();
    const { buildApp } = await import('./app.js');
    server = buildApp().listen(env.PORT, () => {
      logger.info(`API listening on http://localhost:${env.PORT}  (queue dashboard: /admin/queues)`);
    });
    server.on('error', (err) => {
      logger.fatal({ err }, 'HTTP server failed (is the port already in use?)');
      process.exit(1);
    });
  }

  if (role !== 'api') {
    await reconcileOnBoot();
    worker = startWorker();
  }

  // Graceful shutdown: stop taking new jobs, let in-flight sends finish, then close connections.
  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'shutting down gracefully');
    const force = setTimeout(() => process.exit(1), 25_000);
    force.unref();
    try {
      await Promise.all([
        new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve())),
        worker?.close(),
      ]);
      await emailQueue.close();
      await closeTransports();
      await redis.quit();
      await pool.end();
    } catch (err) {
      logger.error({ err }, 'error during shutdown');
    }
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

export function run(role: Role) {
  start(role).catch((err) => {
    logger.fatal({ err }, 'failed to start');
    process.exit(1);
  });
}
