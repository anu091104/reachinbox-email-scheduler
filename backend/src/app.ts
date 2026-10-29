import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type RequestHandler } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { timingSafeEqual } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { env } from './config/env.js';
import { db } from './db/client.js';
import { logger } from './lib/logger.js';
import { redis } from './lib/redis.js';
import { errorHandler, notFoundHandler } from './middleware/errors.js';
import { emailQueue } from './queue/email-queue.js';
import { authRouter } from './routes/auth.js';
import { apiRouter } from './routes/emails.js';
import { searchEnabled } from './services/search.js';

const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/** HTTP Basic auth in front of the queue dashboard (it can retry/delete jobs). */
const boardAuth: RequestHandler = (req, res, next) => {
  const [scheme, encoded] = (req.headers.authorization ?? '').split(' ');
  if (scheme === 'Basic' && encoded) {
    const [user, ...rest] = Buffer.from(encoded, 'base64').toString().split(':');
    if (safeEqual(user ?? '', env.BULL_BOARD_USER) && safeEqual(rest.join(':'), env.BULL_BOARD_PASSWORD)) return next();
  }
  res.setHeader('WWW-Authenticate', 'Basic realm="Queue dashboard"');
  res.status(401).send('Authentication required');
};

export function buildApp() {
  const app = express();
  if (env.TRUST_PROXY) app.set('trust proxy', 1);

  // ---- Live BullMQ dashboard -------------------------------------------------
  const board = new ExpressAdapter();
  board.setBasePath('/admin/queues');
  createBullBoard({
    queues: [new BullMQAdapter(emailQueue, { readOnlyMode: false })],
    serverAdapter: board,
    options: { uiConfig: { boardTitle: 'Email Scheduler Queues' } },
  });
  // Mounted before helmet: the dashboard UI ships its own inline scripts.
  app.use('/admin/queues', boardAuth, board.getRouter());

  app.use(helmet());
  app.use(cors({ origin: env.FRONTEND_ORIGIN, credentials: true }));
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());
  app.use(pinoHttp({ logger, autoLogging: { ignore: (req) => req.url === '/health' } }));

  app.get('/health', async (_req, res) => {
    const checks = await Promise.allSettled([db.execute(sql`select 1`), redis.ping()]);
    const ok = checks.every((c) => c.status === 'fulfilled');
    res.status(ok ? 200 : 503).json({
      status: ok ? 'ok' : 'degraded',
      postgres: checks[0]?.status === 'fulfilled',
      redis: checks[1]?.status === 'fulfilled',
      elasticsearch: searchEnabled(),
    });
  });

  app.use('/api/auth', authRouter);
  app.use('/api', apiRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
