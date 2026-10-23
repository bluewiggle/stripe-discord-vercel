import { after, NextRequest } from "next/server";
import Stripe from "stripe";
import {
  InteractionResponseType,
  InteractionType,
  verifyKey,
} from "discord-interactions";
import { getHold, listOpenHolds } from "@/lib/holds";
import { matchesReminder, performHoldAction } from "@/lib/hold-actions";
import { createHoldLink } from "@/lib/create-hold";
import { checkoutPicker, saveHoldDraft, getHoldDraft, selectCheckoutDate } from "@/lib/checkout-picker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY as string, { timeout: 10000, maxNetworkRetries: 1 });

type DiscordOption = {
  name: string;
  value?: string | number | boolean;
  focused?: boolean;
};

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function autocompleteResponse(choices: { name: string; value: string }[]) {
  return jsonResponse({
    type: InteractionResponseType.APPLICATION_COMMAND_AUTOCOMPLETE_RESULT,
    data: { choices: choices.slice(0, 25) },
  });
}

// Builds the label shown in the Discord dropdown, e.g.
// "$300.00 - Apt 4B (…kX9a)"
function formatCaptureDeadline(captureBefore?: number) {
  if (!captureBefore) return "expiry unavailable";

  return new Intl.DateTimeFormat("en-AU", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "Australia/Sydney",
    timeZoneName: "short",
  }).format(new Date(captureBefore * 1000));
}

function describeHold(
  amount: number,
  note: string,
  paymentIntentId: string,
  captureBefore?: number
) {
  const suffix = paymentIntentId.slice(-6);
  const label = `$${amount.toFixed(2)} - ${note || "no note"} - expires ${formatCaptureDeadline(
    captureBefore
  )} (…${suffix})`;
  return label.length > 100 ? `${label.slice(0, 97)}...` : label;
}

function ephemeral(content: string) {
  return jsonResponse({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      content,
      flags: 64,
    },
  });
}

async function verifyDiscordRequest(req: NextRequest, rawBody: string) {
  const signature = req.headers.get("x-signature-ed25519");
  const timestamp = req.headers.get("x-signature-timestamp");
  const publicKey = process.env.DISCORD_PUBLIC_KEY;

  if (!signature || !timestamp || !publicKey) return false;

  return verifyKey(rawBody, signature, timestamp, publicKey);
}

function getOption(options: DiscordOption[], name: string) {
  return options.find((option) => option.name === name)?.value;
}

function isUserAllowed(userId?: string) {
  const raw = process.env.AUTHORIZED_DISCORD_USER_IDS?.trim();

  if (!raw) return true;
  if (!userId) return false;

  const allowedIds = raw
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);

  return allowedIds.includes(userId);
}

function requireStripeKey() {
  const key = process.env.STRIPE_SECRET_KEY;

  if (!key) throw new Error("Missing STRIPE_SECRET_KEY environment variable.");
  if (key.startsWith("rk_")) throw new Error("You are using a restricted Stripe key. Use sk_test_ or sk_live_.");
  if (!key.startsWith("sk_test_") && !key.startsWith("sk_live_")) {
    throw new Error("Invalid Stripe key. It should start with sk_test_ or sk_live_.");
  }
}

type DiscordInteraction = {
  id: string;
  application_id: string;
  token: string;
  channel_id?: string;
  guild_id?: string;
  message?: { id: string };
  data: { custom_id?: string; components?: any[]; values?: string[] };
};

function deferredResponse(interaction: DiscordInteraction, work: () => Promise<string>, updatePicker = false) {
  after(async () => {
    let content: string;
    try {
      content = await work();
    } catch (error: any) {
      console.error("Hold command failed:", error.message);
      content = `Error: ${error.message || "Could not process this hold."}`;
    }
    try {
      const response = await fetch(
        `https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(updatePicker
            ? { components: [{ type: 10, content }], allowed_mentions: { parse: [] } }
            : { content, allowed_mentions: { parse: [] } }),
          signal: AbortSignal.timeout(10000),
        }
      );
      if (!response.ok) console.error("Failed to update Discord hold response:", response.status);
    } catch {
      console.error("Failed to deliver the Discord hold response.");
    }
  });
  return jsonResponse(updatePicker
    ? { type: InteractionResponseType.DEFERRED_UPDATE_MESSAGE }
    : { type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE, data: { flags: 64 } });
}

async function handleCreateHold(options: DiscordOption[], interaction: DiscordInteraction, userId?: string) {
  if (!getOption(options, "checkout_date")) {
    await saveHoldDraft({
      amount: Number(getOption(options, "amount")), name: String(getOption(options, "name") || ""),
      interactionId: interaction.id, userId: userId || "",
      channelId: interaction.channel_id || "", guildId: interaction.guild_id || "",
    });
    return jsonResponse({ type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE, data: checkoutPicker(interaction.id) });
  }
  // Support commands already composed before the date-selector rollout.
  return deferredResponse(interaction, () => createHoldLink(stripe, {
    amount: Number(getOption(options, "amount")),
    name: String(getOption(options, "name") ?? getOption(options, "apartment") ?? ""),
    checkoutDate: String(getOption(options, "checkout_date") || ""),
    interactionId: interaction.id,
    userId,
    channelId: interaction.channel_id,
    guildId: interaction.guild_id,
  }));
}

async function handleCheckoutPicker(interaction: DiscordInteraction, userId: string) {
  const match = /^checkout:(month|day):(\d+)(?::(\d{4}-\d{2}-\d{2}))?$/.exec(interaction.data.custom_id || "");
  if (!match) return ephemeral("Unknown checkout date selection.");
  const [, action, id, date] = match;
  const draft = await getHoldDraft(id, userId, interaction.channel_id || "", interaction.guild_id || "");
  if (action === "month") {
    if (draft.checkoutDate) return ephemeral("A checkout date has already been selected for this hold.");
    return jsonResponse({ type: InteractionResponseType.UPDATE_MESSAGE, data: checkoutPicker(id, interaction.data.values?.[0] || "") });
  }
  await selectCheckoutDate(id, date || "");
  return deferredResponse(interaction, () => createHoldLink(stripe, { ...draft, checkoutDate: date! }), true);
}

function modalAmount(components: any[] = []): string {
  for (const item of components) {
    if (item.custom_id === "amount") return String(item.value ?? "");
    const nested = modalAmount(item.components || (item.component ? [item.component] : []));
    if (nested) return nested;
  }
  return "";
}

async function handleHoldComponent(interaction: DiscordInteraction, isModal: boolean) {
  const match = /^hold:(release|capture|submit):(pi_[A-Za-z0-9]+)(?::(\d+))?$/.exec(interaction.data.custom_id || "");
  if (!match || (isModal ? match[1] !== "submit" : match[1] === "submit")) {
    return ephemeral("Unknown hold action.");
  }
  const [, action, paymentIntentId, modalMessageId] = match;
  const origin = {
    channelId: interaction.channel_id || "",
    guildId: interaction.guild_id || "",
    messageId: isModal ? modalMessageId || "" : interaction.message?.id || "",
  };
  if (action === "capture") {
    const hold = await getHold(paymentIntentId);
    if (!matchesReminder(hold, origin)) return ephemeral("This reminder is no longer active.");
    return jsonResponse({
      type: InteractionResponseType.MODAL,
      data: {
        custom_id: `hold:submit:${paymentIntentId}:${origin.messageId}`,
        title: "Capture deposit hold",
        components: [{
          type: 18,
          label: "Amount to charge (AUD)",
          description: "This charges the card. Any remaining hold is released.",
          component: {
            type: 4, custom_id: "amount", style: 1, required: true,
            placeholder: `Up to $${hold!.amount.toFixed(2)}`, max_length: 12,
          },
        }],
      },
    });
  }
  return deferredResponse(interaction, () => performHoldAction(stripe, {
    action: action === "release" ? "release" : "capture",
    paymentIntentId, interactionId: interaction.id, origin,
    ...(isModal ? { amount: modalAmount(interaction.data.components) } : {}),
  }));
}

async function handleAutocomplete(options: DiscordOption[]) {
  const focused = options.find((option) => option.focused);
  const typed = String(focused?.value ?? "").trim().toLowerCase();

  let holds: Awaited<ReturnType<typeof listOpenHolds>> = [];
  try {
    holds = await listOpenHolds();
  } catch (error) {
    console.error("Failed to list open holds for autocomplete:", error);
    return autocompleteResponse([]);
  }

  const matches = holds.filter((hold) => {
    if (!typed) return true;
    return (
      hold.note.toLowerCase().includes(typed) ||
      hold.paymentIntentId.toLowerCase().includes(typed) ||
      String(hold.amount).includes(typed)
    );
  });

  return autocompleteResponse(
    matches.map((hold) => ({
      name: describeHold(hold.amount, hold.note, hold.paymentIntentId, hold.captureBefore),
      value: hold.paymentIntentId,
    }))
  );
}

export async function GET() {
  return jsonResponse({ ok: true, message: "Discord interactions endpoint is live.", holdLinkFlow: "stripe_payment_link", checkoutReminders: true, checkoutDatePicker: true });
}

export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  const isValidRequest = await verifyDiscordRequest(req, rawBody);

  if (!isValidRequest) {
    return new Response("Bad request signature", { status: 401 });
  }

  const interaction = JSON.parse(rawBody);

  if (interaction.type === InteractionType.PING) {
    return jsonResponse({ type: InteractionResponseType.PONG });
  }

  if (
    interaction.type !== InteractionType.APPLICATION_COMMAND &&
    interaction.type !== InteractionType.APPLICATION_COMMAND_AUTOCOMPLETE &&
    interaction.type !== InteractionType.MESSAGE_COMPONENT &&
    interaction.type !== InteractionType.MODAL_SUBMIT
  ) {
    return ephemeral("Unsupported interaction type.");
  }

  const userId = interaction.member?.user?.id || interaction.user?.id;

  if (interaction.type === InteractionType.APPLICATION_COMMAND_AUTOCOMPLETE) {
    if (!isUserAllowed(userId)) return autocompleteResponse([]);
    return await handleAutocomplete(interaction.data.options || []);
  }

  if (!isUserAllowed(userId)) {
    return ephemeral("You are not authorised to use this command.");
  }

  try {
    requireStripeKey();

    if (interaction.type === InteractionType.MESSAGE_COMPONENT || interaction.type === InteractionType.MODAL_SUBMIT) {
      if (interaction.type === InteractionType.MESSAGE_COMPONENT && interaction.data.custom_id?.startsWith("checkout:")) {
        return await handleCheckoutPicker(interaction, userId);
      }
      return await handleHoldComponent(interaction, interaction.type === InteractionType.MODAL_SUBMIT);
    }

    const commandName = interaction.data.name;
    const options = interaction.data.options || [];

    if (commandName === "create-hold") return await handleCreateHold(options, interaction, userId);
    if (commandName === "release-hold" || commandName === "capture-hold") {
      return deferredResponse(interaction, () => performHoldAction(stripe, {
        action: commandName === "release-hold" ? "release" : "capture",
        paymentIntentId: String(getOption(options, "payment_intent_id") || "").trim(),
        interactionId: interaction.id,
        ...(commandName === "capture-hold" ? { amount: String(getOption(options, "amount") ?? "") } : {}),
      }));
    }

    return ephemeral("Unknown command.");
  } catch (error: any) {
    console.error(error);
    return ephemeral(`Error: ${error.message || "Something went wrong."}`);
  }
}
