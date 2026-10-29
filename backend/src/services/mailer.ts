import nodemailer, { type Transporter } from 'nodemailer';
import { count } from 'drizzle-orm';
import { env } from '../config/env.js';
import { db } from '../db/client.js';
import { senders, type Sender } from '../db/schema.js';
import { logger } from '../lib/logger.js';

const log = logger.child({ module: 'mailer' });

/**
 * One pooled SMTP transporter per sender, created lazily and reused.
 * Pooling keeps a couple of authenticated connections open instead of doing a
 * TCP + TLS + AUTH handshake for every single email. Nodemailer's pool is safe
 * to share between concurrently running jobs.
 */
const transports = new Map<string, Transporter>();

function transportFor(sender: Sender): Transporter {
  let t = transports.get(sender.id);
  if (!t) {
    t = nodemailer.createTransport({
      host: sender.smtpHost,
      port: sender.smtpPort,
      secure: sender.smtpSecure,
      auth: { user: sender.smtpUser, pass: sender.smtpPass },
      pool: true,
      maxConnections: 2,
      connectionTimeout: 15_000,
      socketTimeout: 30_000,
    });
    transports.set(sender.id, t);
  }
  return t;
}

export interface OutgoingEmail {
  emailId: string;
  sender: Sender;
  to: string;
  subject: string;
  html: string;
  attachments: { filename: string; contentType: string; data: Buffer }[];
}

export async function deliver(msg: OutgoingEmail) {
  const info = await transportFor(msg.sender).sendMail({
    from: { name: msg.sender.label, address: msg.sender.email },
    to: msg.to,
    subject: msg.subject,
    html: msg.html,
    // A deterministic Message-ID: if the same email were ever retried after a
    // crash, mail systems can recognise it as the same message.
    messageId: `<${msg.emailId}@reachinbox-scheduler.local>`,
    headers: { 'X-Scheduler-Email-Id': msg.emailId },
    attachments: msg.attachments.map((a) => ({ filename: a.filename, contentType: a.contentType, content: a.data })),
  });
  const preview = nodemailer.getTestMessageUrl(info);
  return { messageId: info.messageId as string, previewUrl: typeof preview === 'string' ? preview : null };
}

/** 5xx SMTP replies are permanent ("mailbox does not exist"): retrying is pointless. */
export function isPermanentSmtpError(err: unknown): boolean {
  const code = (err as { responseCode?: number } | null)?.responseCode;
  return typeof code === 'number' && code >= 500 && code < 600;
}

export async function closeTransports() {
  for (const t of transports.values()) t.close();
  transports.clear();
}

/** Creates fresh Ethereal inboxes and stores them as senders. */
export async function createEtherealSenders(howMany: number): Promise<Sender[]> {
  const created: Sender[] = [];
  for (let i = 0; i < howMany; i++) {
    const acc = await nodemailer.createTestAccount();
    const [row] = await db
      .insert(senders)
      .values({
        label: `Ethereal Sender ${i + 1}`,
        email: acc.user,
        smtpHost: acc.smtp.host ?? env.SMTP_HOST,
        smtpPort: acc.smtp.port ?? env.SMTP_PORT,
        smtpSecure: acc.smtp.secure ?? env.SMTP_SECURE,
        smtpUser: acc.user,
        smtpPass: acc.pass,
      })
      .onConflictDoNothing()
      .returning();
    if (row) created.push(row);
  }
  return created;
}

/** On first boot, make sure there is something to send from. */
export async function ensureSenders(): Promise<void> {
  const [row] = await db.select({ n: count() }).from(senders);
  if ((row?.n ?? 0) > 0 || env.AUTO_PROVISION_SENDERS === 0) return;
  try {
    const made = await createEtherealSenders(env.AUTO_PROVISION_SENDERS);
    log.info({ senders: made.map((s) => s.email) }, 'provisioned Ethereal sender accounts');
  } catch (err) {
    log.error({ err }, 'could not create Ethereal accounts automatically; run `npm run senders:create`');
  }
}
