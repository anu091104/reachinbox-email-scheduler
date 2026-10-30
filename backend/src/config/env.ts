import 'dotenv/config';
import { z } from 'zod';

/**
 * Every tunable value lives here and is validated once at boot.
 * If something is missing or malformed the process refuses to start,
 * which is far better than failing at 3 AM when the first email is due.
 */

const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  // --- Storage -------------------------------------------------------------
  DATABASE_URL: z.string().url(),
  DATABASE_SSL: bool.default('false'),
  REDIS_URL: z.string().url(),
  ELASTICSEARCH_URL: z.string().url().optional().or(z.literal('').transform(() => undefined)),
  ELASTICSEARCH_API_KEY: z.string().optional(),
  ELASTICSEARCH_INDEX: z.string().default('scheduled-emails'),

  // --- Auth ----------------------------------------------------------------
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  GOOGLE_CLIENT_ID: z.string().optional().default(''),
  FRONTEND_ORIGIN: z
    .string()
    .default('http://localhost:5173')
    .transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean)),
  COOKIE_SECURE: bool.default('false'),
  TRUST_PROXY: bool.default('false'),

  // --- Queue / worker ------------------------------------------------------
  QUEUE_NAME: z.string().regex(/^[a-z0-9-]+$/).default('email-send'),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(100).default(5),
  JOB_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),
  JOB_BACKOFF_MS: z.coerce.number().int().min(1000).default(30_000),
  SEND_LEASE_MS: z.coerce.number().int().min(10_000).default(60_000),

  // --- Throughput controls -------------------------------------------------
  MIN_DELAY_BETWEEN_EMAILS_MS: z.coerce.number().int().min(0).default(2000),
  SEND_GAP_SCOPE: z.enum(['sender', 'global']).default('sender'),
  MAX_EMAILS_PER_HOUR: z.coerce.number().int().min(0).default(200),
  MAX_EMAILS_PER_HOUR_PER_SENDER: z.coerce.number().int().min(0).default(50),

  // --- SMTP (Ethereal) -----------------------------------------------------
  SMTP_HOST: z.string().default('smtp.ethereal.email'),
  SMTP_PORT: z.coerce.number().int().default(587),
  SMTP_SECURE: bool.default('false'),
  AUTO_PROVISION_SENDERS: z.coerce.number().int().min(0).max(10).default(3),
  /** Force every sender onto this SMTP port (e.g. 2525 on hosts that block 587). Empty = use each sender's own port. */
  SMTP_PORT_OVERRIDE: z
    .string()
    .optional()
    .transform((v) => (v && v.trim() ? Number(v) : undefined))
    .pipe(z.number().int().positive().optional()),

  // --- Bull Board ----------------------------------------------------------
  BULL_BOARD_USER: z.string().default('admin'),
  BULL_BOARD_PASSWORD: z.string().min(8).default('change-me-please'),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error('Invalid environment configuration:\n', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
export type Env = typeof env;
