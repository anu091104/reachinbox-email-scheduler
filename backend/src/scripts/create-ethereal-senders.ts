/**
 * Usage: npm run senders:create -- 3
 * Creates N brand-new Ethereal inboxes and saves them as senders.
 * Open https://ethereal.email/login with the printed credentials to see what was "sent".
 */
import { pool } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { createEtherealSenders } from '../services/mailer.js';

const n = Math.min(Math.max(Number(process.argv[2] ?? 2) || 2, 1), 10);
await runMigrations();
const made = await createEtherealSenders(n);
for (const s of made) {
  console.log(`${s.email}  password: ${s.smtpPass}`);
}
console.log(`\nCreated ${made.length} sender(s). Log in at https://ethereal.email/login to view messages.`);
await pool.end();
