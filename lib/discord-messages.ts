import { createHash } from "node:crypto";
import type { HoldRecord } from "./holds";
import { displayCheckoutDate } from "./checkout-date";

export async function discordRequest(path: string, method: string, body?: unknown) {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) throw new Error("Discord bot token is not configured.");
  const response = await fetch(`https://discord.com/api/v10${path}`, {
    method,
    headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`Discord request failed (${response.status}).`);
  return response.status === 204 ? null : response.json();
}

export function reminderMessage(hold: HoldRecord) {
  return {
    content: `<@${hold.createdBy}> **Deposit hold ready for review**\n\n` +
      `Name: **${hold.note}**\nAmount held: **$${hold.amount.toFixed(2)} AUD**\n` +
      `Checkout: **${displayCheckoutDate(hold.checkoutDate!)}**\n` +
      `Checkout has passed. Release the hold if no charge is needed.\n` +
      (hold.captureBefore ? `Hold expires: <t:${hold.captureBefore}:f>\n` : "") +
      `Reference: ${hold.paymentIntentId}`,
    allowed_mentions: { parse: [], users: [hold.createdBy] },
    // Discord deduplicates recent sends with this nonce if a request is retried.
    nonce: createHash("sha256").update(`hold-reminder:${hold.paymentIntentId}`).digest("hex").slice(0, 24),
    enforce_nonce: true,
    components: [{ type: 1, components: [
      { type: 2, style: 3, label: "Release hold", custom_id: `hold:release:${hold.paymentIntentId}` },
      { type: 2, style: 4, label: "Capture amount…", custom_id: `hold:capture:${hold.paymentIntentId}` },
    ] }],
  };
}

export async function closeReminder(hold: HoldRecord | null, status: string) {
  const channelId = hold?.reminderChannelId || hold?.channelId;
  if (!hold?.reminderMessageId || !channelId) return;
  await discordRequest(`/channels/${channelId}/messages/${hold.reminderMessageId}`, "PATCH", {
    content: `✅ **Deposit hold ${status}**\nName: **${hold.note}**\nReference: ${hold.paymentIntentId}`,
    components: [], allowed_mentions: { parse: [] },
  });
}
