import Stripe from "stripe";
import * as holds from "./holds";
import { closeReminder } from "./discord-messages";

type ReminderOrigin = { channelId: string; guildId: string; messageId: string };

export function matchesReminder(hold: holds.HoldRecord | null, origin: ReminderOrigin) {
  return Boolean(hold && hold.channelId === origin.channelId && hold.guildId === origin.guildId &&
    hold.reminderMessageId && hold.reminderMessageId === origin.messageId);
}

export function captureCents(value: string | number) {
  const text = String(value).trim();
  if (!/^\d+(\.\d{1,2})?$/.test(text)) throw new Error("Enter a positive AUD amount with at most two decimal places.");
  const cents = Math.round(Number(text) * 100);
  if (!Number.isSafeInteger(cents) || cents < 1) throw new Error("Enter a positive AUD amount.");
  return cents;
}

export async function performHoldAction(stripe: Stripe, input: {
  action: "release" | "capture"; paymentIntentId: string; interactionId: string;
  amount?: string | number; origin?: ReminderOrigin;
}) {
  const id = input.paymentIntentId;
  if (!/^pi_[A-Za-z0-9]+$/.test(id)) throw new Error("Invalid PaymentIntent ID.");
  const cents = input.action === "capture" ? captureCents(input.amount ?? "") : undefined;
  const lock = await holds.acquireHoldLock(id);
  if (!lock) throw new Error("This hold is being processed. Please try again in a moment.");
  try {
    const saved = await holds.getHold(id);
    if (input.origin && !matchesReminder(saved, input.origin)) {
      throw new Error("This reminder is no longer active. Use /release-hold or /capture-hold to check the hold.");
    }
    const intent = await stripe.paymentIntents.retrieve(id);
    if (intent.status !== "requires_capture") {
      await holds.removeHold(id);
      await closeReminder(saved, intent.status).catch(() => {});
      return `This hold is already **${intent.status}**. No payment action was taken.`;
    }
    if (cents !== undefined && cents > intent.amount_capturable) {
      throw new Error(`You can capture up to $${(intent.amount_capturable / 100).toFixed(2)} AUD.`);
    }
    const options = { idempotencyKey: `discord-${input.action}-${input.interactionId}` };
    const updated = input.action === "release"
      ? await stripe.paymentIntents.cancel(id, {}, options)
      : await stripe.paymentIntents.capture(id, { amount_to_capture: cents, final_capture: true }, options);
    await holds.removeHold(id);
    const summary = input.action === "release" ? "released" : `captured ($${(updated.amount_received / 100).toFixed(2)} AUD)`;
    await closeReminder(saved, summary).catch(error => console.error("Could not update reminder:", error.message));
    return `✅ **Hold ${summary}**\n\n` + (saved?.note ? `Name: **${saved.note}**\n` : "") +
      `Reference: ${id}\nStatus: ${updated.status}`;
  } finally {
    await holds.releaseHoldLock(id, lock);
  }
}
