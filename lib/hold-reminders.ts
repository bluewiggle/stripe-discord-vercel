import Stripe from "stripe";
import * as holds from "./holds";
import { closeReminder, discordRequest, reminderMessage } from "./discord-messages";
import { REMINDER_CHANNEL_ID, REMINDER_GUILD_ID } from "./reminder-destination";

export async function sendDueReminders(stripe: Stripe, now = Date.now()) {
  const result = { sent: 0, skipped: 0, failed: 0 };
  const started = Date.now();
  const ids = await holds.listDueReminderIds(now);
  for (const id of ids) {
    if (Date.now() - started > 40000) break; // Leave remaining items queued for the next run.
    const lock = await holds.acquireHoldLock(id);
    if (!lock) continue;
    try {
      const hold = await holds.getHold(id);
      if (!hold || hold.reminderMessageId || !hold.createdBy || !hold.channelId || !hold.checkoutDate) {
        await holds.clearReminderQueue(id);
        result.skipped++;
        continue;
      }
      if (!hold.reminderAt || hold.reminderAt > now) continue;
      if (hold.guildId !== REMINDER_GUILD_ID) throw new Error("Hold belongs to a different Discord server.");
      // Includes changes made directly in Stripe, not only changes via the bot.
      const intent = await stripe.paymentIntents.retrieve(id);
      if (intent.status !== "requires_capture") {
        await holds.removeHold(id);
        await closeReminder(hold, intent.status).catch(() => {});
        result.skipped++;
        continue;
      }
      const message = await discordRequest(`/channels/${REMINDER_CHANNEL_ID}/messages`, "POST", reminderMessage(hold));
      if (!message?.id) throw new Error("Discord did not return a reminder message ID.");
      await holds.markReminderSent(id, message.id, REMINDER_CHANNEL_ID);
      result.sent++;
    } catch (error: any) {
      // Keep the item queued so a temporary Discord/Stripe failure is retried.
      console.error(`Reminder failed for ${id}:`, error.message);
      await holds.retryReminderLater(id, now);
      result.failed++;
    } finally {
      await holds.releaseHoldLock(id, lock);
    }
  }
  return result;
}
