/** Rebuilds the Elasticsearch index from Postgres (the source of truth). */
import { asc, gt } from 'drizzle-orm';
import { db, pool } from '../db/client.js';
import { emails } from '../db/schema.js';
import { es, initSearch, searchEnabled, syncToSearch } from '../services/search.js';

await initSearch();
if (!searchEnabled()) {
  console.error('Elasticsearch is not reachable; check ELASTICSEARCH_URL');
  process.exit(1);
}
let last = '00000000-0000-0000-0000-000000000000';
let total = 0;
for (;;) {
  const batch = await db.select({ id: emails.id }).from(emails).where(gt(emails.id, last)).orderBy(asc(emails.id)).limit(1000);
  if (!batch.length) break;
  await syncToSearch(batch.map((b) => b.id));
  total += batch.length;
  last = batch.at(-1)!.id;
}
console.log(`Re-indexed ${total} emails`);
await es?.close();
await pool.end();
