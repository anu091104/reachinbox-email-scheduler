import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { db } from './client.js';
import { logger } from '../lib/logger.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// Works from both src/db (tsx) and dist/db (compiled): migrations live in <backend>/drizzle
const migrationsFolder = path.resolve(here, '..', '..', 'drizzle');

export async function runMigrations(): Promise<void> {
  await migrate(db, { migrationsFolder });
  logger.info('database migrations applied');
}
