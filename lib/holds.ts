import { Redis } from "@upstash/redis";
import { randomUUID } from "node:crypto";

// Uses UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN from env.
// These are auto-populated if you add "Upstash for Redis" from the
// Vercel dashboard's Storage tab, or set manually from upstash.com.
const redis = Redis.fromEnv();

export type HoldRecord = {
  paymentIntentId: string;
  amount: number;
  note: string;
  portalLink?: string; // Retained for holds created before Stripe-hosted confirmation.
  createdAt: number;
  // Stripe provides this after the card is authorised. It is the authoritative
  // deadline for capture, including whether an extended authorisation applied.
  captureBefore?: number;
  cardBrand?: string;
  extendedAuthorizationStatus?: "enabled" | "disabled";
  createdBy?: string;
  checkoutDate?: string;
  reminderAt?: number;
  channelId?: string;
  guildId?: string;
  reminderMessageId?: string;
  reminderChannelId?: string;
};

const OPEN_HOLDS_KEY = "holds:open"; // sorted set: score = createdAt, member = pi_id
const holdKey = (id: string) => `hold:${id}`;
const REMINDERS_KEY = "holds:reminders";
const closedKey = (id: string) => `hold:closed:${id}`;

export async function saveHold(record: HoldRecord) {
  // Merge atomically: webhook retries must preserve the sent reminder marker.
  // A tombstone prevents delayed webhooks from resurrecting resolved holds.
  await redis.eval(`
    if redis.call('EXISTS', KEYS[4]) == 1 then return 0 end
    local old = redis.call('GET', KEYS[1])
    local record = old and cjson.decode(old) or {}
    local incoming = cjson.decode(ARGV[1])
    for k,v in pairs(incoming) do record[k] = v end
    redis.call('SET', KEYS[1], cjson.encode(record))
    redis.call('ZADD', KEYS[2], record.createdAt, record.paymentIntentId)
    if record.reminderAt and record.createdBy and record.channelId and not record.reminderMessageId then
      redis.call('ZADD', KEYS[3], record.reminderAt, record.paymentIntentId)
    end
    return 1
  `, [holdKey(record.paymentIntentId), OPEN_HOLDS_KEY, REMINDERS_KEY, closedKey(record.paymentIntentId)], [JSON.stringify(record)]);
}

export async function removeHold(paymentIntentId: string) {
  await redis.eval(`
    redis.call('SET', KEYS[4], '1', 'EX', 7776000)
    redis.call('DEL', KEYS[1])
    redis.call('ZREM', KEYS[2], ARGV[1])
    redis.call('ZREM', KEYS[3], ARGV[1])
    return 1
  `, [holdKey(paymentIntentId), OPEN_HOLDS_KEY, REMINDERS_KEY, closedKey(paymentIntentId)], [paymentIntentId]);
}

export async function listDueReminderIds(now: number, limit = 100) {
  return redis.zrange<string[]>(REMINDERS_KEY, 0, now, { byScore: true, offset: 0, count: limit });
}

export async function clearReminderQueue(id: string) {
  await redis.zrem(REMINDERS_KEY, id);
}

export async function retryReminderLater(id: string, now: number) {
  await redis.zadd(REMINDERS_KEY, { score: now + 300000, member: id });
}

export async function markReminderSent(id: string, messageId: string, channelId: string) {
  await redis.eval(`
    local raw = redis.call('GET', KEYS[1])
    if raw then
      local record = cjson.decode(raw)
      record.reminderMessageId = ARGV[2]
      record.reminderChannelId = ARGV[3]
      redis.call('SET', KEYS[1], cjson.encode(record))
    end
    redis.call('ZREM', KEYS[2], ARGV[1])
    return 1
  `, [holdKey(id), REMINDERS_KEY], [id, messageId, channelId]);
}

// Used by both reminder delivery and money actions to avoid overlapping work.
export async function acquireHoldLock(id: string): Promise<string | null> {
  const token = randomUUID();
  const result = await redis.set(`hold:lock:${id}`, token, { nx: true, ex: 120 });
  return result ? token : null;
}

export async function releaseHoldLock(id: string, token: string) {
  await redis.eval(`
    if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
    return 0
  `, [`hold:lock:${id}`], [token]);
}

export async function getHold(paymentIntentId: string): Promise<HoldRecord | null> {
  return redis.get<HoldRecord>(holdKey(paymentIntentId));
}

// Most recently created holds first.
export async function listOpenHolds(limit = 25): Promise<HoldRecord[]> {
  const ids = await redis.zrange<string[]>(OPEN_HOLDS_KEY, 0, limit - 1, {
    rev: true,
  });

  if (!ids.length) return [];

  const records = await Promise.all(ids.map((id) => getHold(id)));

  const stale = ids.filter((id, i) => !records[i]);
  if (stale.length) {
    await Promise.all(stale.map((id) => redis.zrem(OPEN_HOLDS_KEY, id)));
  }

  return records.filter((r): r is HoldRecord => Boolean(r));
}
