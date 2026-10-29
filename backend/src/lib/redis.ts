import { Redis, type RedisOptions } from 'ioredis';
import { env } from '../config/env.js';

/**
 * BullMQ needs `maxRetriesPerRequest: null` on connections used by workers so a
 * temporary Redis blip makes commands wait instead of throwing.
 * Each Queue/Worker gets its own connection (blocking commands must not share one).
 */
export function createRedis(overrides: RedisOptions = {}): Redis {
  return new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    ...overrides,
  });
}

/** Shared connection for ordinary commands (rate limiter, health checks). */
export const redis = createRedis();
