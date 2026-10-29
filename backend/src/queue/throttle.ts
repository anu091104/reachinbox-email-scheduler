import type { Redis, Result } from 'ioredis';

// Teach TypeScript about the two custom Lua commands registered below.
declare module 'ioredis' {
  interface RedisCommander<Context> {
    throttleAcquire(...args: (string | number)[]): Result<(number | string)[], Context>;
    throttleRelease(...args: string[]): Result<number, Context>;
  }
}

/**
 * Distributed send throttle.
 *
 * All the bookkeeping lives in Redis and is checked + updated by ONE Lua script.
 * Redis runs a script atomically (nothing else executes in between), so even with
 * 10 workers on 3 machines, two of them can never both see "49/50 used" and both
 * send email #50 and #51. That is the property in-memory counters cannot give us.
 *
 * Three independent rules are enforced:
 *   1. Minimum gap between two sends (per sender, or global — SEND_GAP_SCOPE),
 *      handed out as reserved time slots so order is preserved.
 *   2. Hourly caps: global, per sender, and per campaign (the "Hourly Limit" field in Compose).
 *   3. Hours are fixed UTC clock windows: 14:00:00.000 – 14:59:59.999 is one bucket.
 *
 * Keys (one counter per hour window, auto-expiring):
 *   rl:gap:<scope>                    -> the latest send slot (ms) handed out in that scope
 *   rl:h:<window>:global              -> sends in this hour across everything
 *   rl:h:<window>:sender:<senderId>   -> sends in this hour from one mailbox
 *   rl:h:<window>:campaign:<id>       -> sends in this hour for one campaign
 *   rl:defer:<window>:<scope>         -> how many jobs were already pushed into <window>
 */

const HOUR_MS = 60 * 60 * 1000;

// Return shapes:
//   {0}                                  -> go ahead and send now
//   {1, slotMs}                          -> a send slot was reserved for you at slotMs; come back then
//   {2, windowEndMs, deferSeq, ruleIdx}  -> an hourly cap is full; move into the next window
//
// The gap rule works like a ticket machine: each caller gets the next free slot
// (last slot + gap). Jobs therefore leave in the order they asked, instead of
// all retrying at random and racing each other.
const ACQUIRE_LUA = `
local now        = tonumber(ARGV[1])
local gap        = tonumber(ARGV[2])
local windowEnd  = tonumber(ARGV[6])
local ttl        = tonumber(ARGV[7])
local held       = tonumber(ARGV[8])

if gap > 0 then
  if held > 0 and held > now + 50 then
    return {1, held}
  end
  local ownsSlot = held > 0 and (now - held) < 5000
  if not ownsSlot then
    local last = tonumber(redis.call('GET', KEYS[1]) or '0')
    local slot = last + gap
    if slot < now then slot = now end
    redis.call('SET', KEYS[1], slot, 'PX', math.floor(slot - now + gap * 4 + 10000))
    if slot > now then
      return {1, slot}
    end
  end
end

local limits = { tonumber(ARGV[3]), tonumber(ARGV[4]), tonumber(ARGV[5]) }
for i = 1, 3 do
  local limit = limits[i]
  if limit > 0 then
    local used = tonumber(redis.call('GET', KEYS[i + 1]) or '0')
    if used >= limit then
      local seq = redis.call('INCR', KEYS[5])
      redis.call('PEXPIRE', KEYS[5], ttl * 2000)
      return {2, windowEnd, seq, i}
    end
  end
end

for i = 1, 3 do
  if limits[i] > 0 then
    redis.call('INCR', KEYS[i + 1])
    redis.call('EXPIRE', KEYS[i + 1], ttl)
  end
end
return {0}
`;

// Gives back the hourly slots if the SMTP call failed before anything was sent.
const RELEASE_LUA = `
for i = 1, #KEYS do
  local v = tonumber(redis.call('GET', KEYS[i]) or '0')
  if v > 0 then redis.call('DECR', KEYS[i]) end
end
return 1
`;

export type HourlyRule = 'global' | 'sender' | 'campaign';
const RULES: HourlyRule[] = ['global', 'sender', 'campaign'];

export type ThrottleDecision =
  | { kind: 'ok'; release: () => Promise<void> }
  | { kind: 'wait'; slotAt: number }
  | { kind: 'defer'; runAt: number; rule: HourlyRule };

export interface ThrottleLimits {
  minGapMs: number;
  gapScope: 'sender' | 'global';
  perHourGlobal: number; // 0 = unlimited
  perHourPerSender: number;
}

export interface AcquireInput {
  senderId: string;
  campaignId: string;
  campaignHourlyLimit: number; // 0 = unlimited
  /** A slot this job reserved on an earlier attempt (0/undefined if none). */
  heldSlot?: number;
  now?: number;
}

export const hourWindow = (ms: number) => Math.floor(ms / HOUR_MS);

export class SendThrottle {
  constructor(
    private readonly redis: Redis,
    private readonly limits: ThrottleLimits,
    private readonly prefix = 'rl',
  ) {
    this.redis.defineCommand('throttleAcquire', { numberOfKeys: 5, lua: ACQUIRE_LUA });
    this.redis.defineCommand('throttleRelease', { numberOfKeys: 3, lua: RELEASE_LUA });
  }

  private keys(input: AcquireInput, window: number) {
    const p = this.prefix;
    const gapScope = this.limits.gapScope === 'global' ? 'global' : `sender:${input.senderId}`;
    return {
      gap: `${p}:gap:${gapScope}`,
      global: `${p}:h:${window}:global`,
      sender: `${p}:h:${window}:sender:${input.senderId}`,
      campaign: `${p}:h:${window}:campaign:${input.campaignId}`,
      // deferred jobs are spaced out inside the *next* window, per gap scope
      defer: `${p}:defer:${window + 1}:${gapScope}`,
    };
  }

  async acquire(input: AcquireInput): Promise<ThrottleDecision> {
    const now = input.now ?? Date.now();
    const window = hourWindow(now);
    const windowEnd = (window + 1) * HOUR_MS;
    const ttlSeconds = Math.ceil((windowEnd - now) / 1000) + 60;
    const k = this.keys(input, window);

    const raw = await this.redis.throttleAcquire(
        k.gap,
        k.global,
        k.sender,
        k.campaign,
        k.defer,
        now,
        this.limits.minGapMs,
        this.limits.perHourGlobal,
        this.limits.perHourPerSender,
        Math.max(0, input.campaignHourlyLimit),
        windowEnd,
        ttlSeconds,
        input.heldSlot ?? 0,
      );

    const code = Number(raw[0]);
    if (code === 0) {
      return {
        kind: 'ok',
        release: async () => {
          await this.redis.throttleRelease(k.global, k.sender, k.campaign);
        },
      };
    }
    if (code === 1) return { kind: 'wait', slotAt: Number(raw[1]) };

    // Hourly cap reached. Push into the next window, keeping arrival order:
    // the Nth job deferred into a window lands N * gap after the window opens.
    const seq = Number(raw[2]);
    const spacing = Math.max(this.limits.minGapMs, 250);
    return {
      kind: 'defer',
      runAt: Number(raw[1]) + (seq - 1) * spacing,
      rule: RULES[Number(raw[3]) - 1] ?? 'global',
    };
  }

  /** Read-only snapshot for the dashboard / health endpoint. */
  async usage(senderIds: string[], now = Date.now()) {
    const w = hourWindow(now);
    const p = this.prefix;
    const keys = [`${p}:h:${w}:global`, ...senderIds.map((id) => `${p}:h:${w}:sender:${id}`)];
    const values = await this.redis.mget(...keys);
    const [global, ...perSender] = values.map((v) => Number(v ?? 0));
    return {
      windowStartedAt: new Date(w * HOUR_MS).toISOString(),
      windowEndsAt: new Date((w + 1) * HOUR_MS).toISOString(),
      global: { used: global ?? 0, limit: this.limits.perHourGlobal },
      senders: senderIds.map((id, i) => ({ senderId: id, used: perSender[i] ?? 0, limit: this.limits.perHourPerSender })),
    };
  }
}
