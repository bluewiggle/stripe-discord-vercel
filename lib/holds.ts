import { Redis } from "@upstash/redis";

// Uses UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN from env.
// These are auto-populated if you add "Upstash for Redis" from the
// Vercel dashboard's Storage tab, or set manually from upstash.com.
const redis = Redis.fromEnv();

export type HoldRecord = {
  paymentIntentId: string;
  amount: number;
  note: string;
  portalLink: string;
  createdAt: number;
  createdBy?: string;
};

const OPEN_HOLDS_KEY = "holds:open"; // sorted set: score = createdAt, member = pi_id
const holdKey = (id: string) => `hold:${id}`;

export async function saveHold(record: HoldRecord) {
  await redis.set(holdKey(record.paymentIntentId), record);
  await redis.zadd(OPEN_HOLDS_KEY, {
    score: record.createdAt,
    member: record.paymentIntentId,
  });
}

export async function removeHold(paymentIntentId: string) {
  await redis.del(holdKey(paymentIntentId));
  await redis.zrem(OPEN_HOLDS_KEY, paymentIntentId);
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