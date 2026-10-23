import { Redis } from "@upstash/redis";
import { checkoutSchedule } from "./checkout-date";

const redis = Redis.fromEnv();
const ttl = 7200;
const key = (id: string) => `hold:draft:${id}`;
export type HoldDraft = {
  amount: number; name: string; interactionId: string;
  userId: string; channelId: string; guildId: string;
  checkoutDate?: string;
};

export function pickerMonths(now = Date.now()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Australia/Sydney", year: "numeric", month: "2-digit",
  }).formatToParts(new Date(now));
  const year = Number(parts.find(p => p.type === "year")!.value);
  const month = Number(parts.find(p => p.type === "month")!.value);
  return Array.from({ length: 24 }, (_, i) => new Date(Date.UTC(year, month - 1 + i, 1)).toISOString().slice(0, 7));
}

export function checkoutPicker(id: string, month = pickerMonths()[0], now = Date.now()) {
  const months = pickerMonths(now);
  if (!months.includes(month)) throw new Error("Choose a checkout month within the next two years.");
  const [year, m] = month.split("-").map(Number);
  const days = new Date(Date.UTC(year, m, 0)).getUTCDate();
  const label = (value: string) => new Intl.DateTimeFormat("en-AU", {
    timeZone: "UTC", month: "long", year: "numeric",
  }).format(new Date(`${value}-01T00:00:00Z`));
  const components: any[] = [{ type: 1, components: [{
    type: 3, custom_id: `checkout:month:${id}`, placeholder: "Choose checkout month",
    min_values: 1, max_values: 1,
    options: months.map(value => ({ label: `Checkout: ${label(value)}`, value, default: value === month })),
  }] }];
  for (let first = 1; first <= days; first += 5) {
    components.push({ type: 1, components: Array.from({ length: Math.min(5, days - first + 1) }, (_, index) => {
      const date = `${month}-${String(first + index).padStart(2, "0")}`;
      let disabled = false;
      try { checkoutSchedule(date, now); } catch { disabled = true; }
      const weekday = new Intl.DateTimeFormat("en-AU", { timeZone: "UTC", weekday: "short" }).format(new Date(`${date}T00:00:00Z`));
      return { type: 2, style: 2, label: `${first + index} ${weekday}`, custom_id: `checkout:day:${id}:${date}`, disabled };
    }) });
  }
  // Components V2 permits 40 total components: month row/select + 31 days/7 rows.
  return { flags: 32768 | 64, components, allowed_mentions: { parse: [] } };
}

export async function saveHoldDraft(draft: HoldDraft) {
  if (!draft.userId || !draft.channelId || !draft.guildId) throw new Error("Create this hold in a server channel.");
  if (!Number.isFinite(draft.amount) || draft.amount < 0.5 || draft.amount > 999999.99) throw new Error("Enter an amount between $0.50 and $999,999.99 AUD.");
  if (!draft.name.trim() || draft.name.length > 500) throw new Error("Enter a name between 1 and 500 characters.");
  await redis.set(key(draft.interactionId), draft, { ex: ttl, nx: true });
}

export async function getHoldDraft(id: string, userId: string, channelId: string, guildId: string) {
  const draft = await redis.get<HoldDraft>(key(id));
  if (!draft) throw new Error("This date selector expired. Run /create-hold again.");
  if (draft.userId !== userId || draft.channelId !== channelId || draft.guildId !== guildId) {
    throw new Error("This date selector belongs to another hold creator or channel.");
  }
  return draft;
}

export async function selectCheckoutDate(id: string, date: string) {
  checkoutSchedule(date);
  if (!pickerMonths().includes(date.slice(0, 7))) throw new Error("Choose a checkout month within the next two years.");
  const result = await redis.eval(`
    local raw = redis.call('GET', KEYS[1])
    if not raw then return 0 end
    local draft = cjson.decode(raw)
    if draft.checkoutDate and draft.checkoutDate ~= ARGV[1] then return -1 end
    draft.checkoutDate = ARGV[1]
    redis.call('SET', KEYS[1], cjson.encode(draft), 'KEEPTTL')
    return 1
  `, [key(id)], [date]);
  if (result !== 1) throw new Error(result === -1 ? "A checkout date has already been selected for this hold." : "This date selector expired. Run /create-hold again.");
}
