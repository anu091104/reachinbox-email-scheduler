/**
 * Runs against a real Redis (REDIS_URL, default localhost:6379) because the
 * whole point of the throttle is its atomic Lua behaviour inside Redis.
 */
import { Redis } from 'ioredis';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { SendThrottle } from '../src/queue/throttle.js';

const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', { maxRetriesPerRequest: null });
const HOUR = 3_600_000;
const T0 = 1_800_000_000_000 - (1_800_000_000_000 % HOUR) + 10 * 60_000; // 10 min into some hour

let prefix = '';
const make = (o: Partial<ConstructorParameters<typeof SendThrottle>[1]> = {}) =>
  new SendThrottle(redis, { minGapMs: 0, gapScope: 'sender', perHourGlobal: 0, perHourPerSender: 0, ...o }, prefix);

beforeEach(() => {
  prefix = `test-${Math.random().toString(36).slice(2)}`;
});
afterAll(async () => {
  const keys = await redis.keys('test-*');
  if (keys.length) await redis.del(...keys);
  await redis.quit();
});

describe('SendThrottle', () => {
  it('hands out consecutive send slots spaced by the minimum gap', async () => {
    const t = make({ minGapMs: 2000 });
    const a = await t.acquire({ senderId: 's1', campaignId: 'c', campaignHourlyLimit: 0, now: T0 });
    const b = await t.acquire({ senderId: 's1', campaignId: 'c', campaignHourlyLimit: 0, now: T0 + 10 });
    const c = await t.acquire({ senderId: 's1', campaignId: 'c', campaignHourlyLimit: 0, now: T0 + 20 });
    expect(a.kind).toBe('ok');
    expect(b).toEqual({ kind: 'wait', slotAt: T0 + 2000 });
    expect(c).toEqual({ kind: 'wait', slotAt: T0 + 4000 });
    // b comes back at its slot holding the reservation -> allowed
    const b2 = await t.acquire({ senderId: 's1', campaignId: 'c', campaignHourlyLimit: 0, now: T0 + 2000, heldSlot: T0 + 2000 });
    expect(b2.kind).toBe('ok');
  });

  it('keeps gaps independent per sender', async () => {
    const t = make({ minGapMs: 2000 });
    expect((await t.acquire({ senderId: 's1', campaignId: 'c', campaignHourlyLimit: 0, now: T0 })).kind).toBe('ok');
    expect((await t.acquire({ senderId: 's2', campaignId: 'c', campaignHourlyLimit: 0, now: T0 })).kind).toBe('ok');
  });

  it('defers to the next hour window in arrival order once the per-sender cap is reached', async () => {
    const t = make({ perHourPerSender: 2 });
    const input = { senderId: 's1', campaignId: 'c', campaignHourlyLimit: 0 };
    expect((await t.acquire({ ...input, now: T0 })).kind).toBe('ok');
    expect((await t.acquire({ ...input, now: T0 + 1 })).kind).toBe('ok');
    const d1 = await t.acquire({ ...input, now: T0 + 2 });
    const d2 = await t.acquire({ ...input, now: T0 + 3 });
    const nextHour = T0 - (T0 % HOUR) + HOUR;
    expect(d1).toMatchObject({ kind: 'defer', rule: 'sender', runAt: nextHour });
    expect(d2.kind === 'defer' && d2.runAt).toBeGreaterThan(nextHour);
    // A new hour opens a fresh bucket
    expect((await t.acquire({ ...input, now: nextHour + 5 })).kind).toBe('ok');
  });

  it('enforces global and per-campaign caps', async () => {
    const t = make({ perHourGlobal: 3 });
    for (let i = 0; i < 3; i++) {
      expect((await t.acquire({ senderId: `s${i}`, campaignId: 'c', campaignHourlyLimit: 0, now: T0 + i })).kind).toBe('ok');
    }
    expect(await t.acquire({ senderId: 's9', campaignId: 'c', campaignHourlyLimit: 0, now: T0 + 9 })).toMatchObject({ kind: 'defer', rule: 'global' });

    const t2 = make();
    expect((await t2.acquire({ senderId: 's', campaignId: 'k', campaignHourlyLimit: 1, now: T0 })).kind).toBe('ok');
    expect(await t2.acquire({ senderId: 's', campaignId: 'k', campaignHourlyLimit: 1, now: T0 + 1 })).toMatchObject({ kind: 'defer', rule: 'campaign' });
  });

  it('never lets concurrent callers exceed the cap (atomicity)', async () => {
    const t = make({ perHourPerSender: 10 });
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) => t.acquire({ senderId: 's1', campaignId: 'c', campaignHourlyLimit: 0, now: T0 + i })),
    );
    expect(results.filter((r) => r.kind === 'ok')).toHaveLength(10);
  });

  it('returns hourly slots when a send fails before delivery', async () => {
    const t = make({ perHourPerSender: 1 });
    const first = await t.acquire({ senderId: 's1', campaignId: 'c', campaignHourlyLimit: 0, now: T0 });
    if (first.kind !== 'ok') throw new Error('expected ok');
    await first.release();
    expect((await t.acquire({ senderId: 's1', campaignId: 'c', campaignHourlyLimit: 0, now: T0 + 1 })).kind).toBe('ok');
  });
});
