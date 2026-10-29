import { sql } from 'drizzle-orm';
import {
  boolean,
  customType,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  name: text('name').notNull(),
  avatarUrl: text('avatar_url'),
  googleSub: text('google_sub').unique(),
  passwordHash: text('password_hash'),
  createdAt: createdAt(),
});

/** A mailbox we are allowed to send from (one Ethereal account each). */
export const senders = pgTable('senders', {
  id: uuid('id').primaryKey().defaultRandom(),
  label: text('label').notNull(),
  email: text('email').notNull().unique(),
  smtpHost: text('smtp_host').notNull(),
  smtpPort: integer('smtp_port').notNull(),
  smtpSecure: boolean('smtp_secure').notNull().default(false),
  smtpUser: text('smtp_user').notNull(),
  smtpPass: text('smtp_pass').notNull(),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: createdAt(),
});

/** One "Compose → Send" action. Fans out into one row per recipient in `emails`. */
export const campaigns = pgTable(
  'campaigns',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    senderId: uuid('sender_id')
      .notNull()
      .references(() => senders.id),
    subject: text('subject').notNull(),
    bodyHtml: text('body_html').notNull(),
    startAt: timestamp('start_at', { withTimezone: true }).notNull(),
    delayBetweenMs: integer('delay_between_ms').notNull().default(0),
    hourlyLimit: integer('hourly_limit').notNull().default(0),
    totalRecipients: integer('total_recipients').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('campaigns_user_idx').on(t.userId, t.createdAt)],
);

export const attachments = pgTable(
  'attachments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    campaignId: uuid('campaign_id')
      .notNull()
      .references(() => campaigns.id, { onDelete: 'cascade' }),
    filename: text('filename').notNull(),
    contentType: text('content_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    data: bytea('data').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('attachments_campaign_idx').on(t.campaignId)],
);

export const emailStatus = pgEnum('email_status', [
  'scheduled', // waiting in Redis as a delayed job
  'processing', // a worker holds the lease and is talking to SMTP
  'sent',
  'failed',
  'cancelled',
]);

export const emails = pgTable(
  'emails',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    campaignId: uuid('campaign_id')
      .notNull()
      .references(() => campaigns.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    senderId: uuid('sender_id')
      .notNull()
      .references(() => senders.id),
    sequence: integer('sequence').notNull(),
    recipient: text('recipient').notNull(),
    subject: text('subject').notNull(),
    bodyHtml: text('body_html').notNull(),
    status: emailStatus('status').notNull().default('scheduled'),
    /** When the email should go out. Moves forward if a rate limit defers it. */
    scheduledAt: timestamp('scheduled_at', { withTimezone: true }).notNull(),
    /** The time the user originally asked for (never changes). */
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull(),
    attempts: integer('attempts').notNull().default(0),
    deferrals: integer('deferrals').notNull().default(0),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
    lastError: text('last_error'),
    messageId: text('message_id'),
    previewUrl: text('preview_url'),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    starred: boolean('starred').notNull().default(false),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => sql`now()`),
  },
  (t) => [
    index('emails_user_status_sched_idx').on(t.userId, t.status, t.scheduledAt),
    index('emails_status_sched_idx').on(t.status, t.scheduledAt),
    uniqueIndex('emails_campaign_seq_uq').on(t.campaignId, t.sequence),
  ],
);

export type User = typeof users.$inferSelect;
export type Sender = typeof senders.$inferSelect;
export type Campaign = typeof campaigns.$inferSelect;
export type Email = typeof emails.$inferSelect;
export type EmailStatus = (typeof emailStatus.enumValues)[number];
