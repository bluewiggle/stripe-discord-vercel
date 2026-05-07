import { NextRequest } from "next/server";
import Stripe from "stripe";
import {
  InteractionResponseType
  InteractionType,
  verifyKey,
} from "discord-interactions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY as string);

type DiscordOption = {
  name: string;
  value?: string | number | boolean;
};

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
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

async function handleCreateHold(options: DiscordOption[]) {
  const amountRaw = getOption(options, "amount");
  const portalLinkRaw = getOption(options, "portal_link");

  const amount = Number(amountRaw);
  const portalLink = String(portalLinkRaw || "").trim();

  if (!amount || amount <= 0) {
    return ephemeral("Invalid amount. Example: `/create-hold amount:300 portal_link:https://...`");
  }

  if (!portalLink.startsWith("https://")) {
    return ephemeral("Portal link must start with `https://`.");
  }

  const amountCents = Math.round(amount * 100);

  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    payment_method_types: ["card"],
    line_items: [
      {
        price_data: {
          currency: "aud",
          product_data: {
            name: `$${amount.toFixed(2)} AUD Damage Deposit Authorisation`,
            description: "Temporary card authorisation hold. This is not captured unless required.",
          },
          unit_amount: amountCents,
        },
        quantity: 1,
      },
    ],
    payment_intent_data: {
      capture_method: "manual",
      description: "Damage deposit authorisation",
      metadata: {
        type: "damage_deposit_hold",
        guest_portal_link: portalLink,
        created_from: "discord",
      },
    },
    success_url: portalLink,
    cancel_url: portalLink,
  });

  return ephemeral(
    `✅ **Damage deposit hold link created**\n\n` +
      `Amount: **$${amount.toFixed(2)} AUD**\n` +
      `Link: ${session.url}\n\n` +
      `After completion, the guest will be redirected to:\n${portalLink}`
  );
}

async function handleReleaseHold(options: DiscordOption[]) {
  const paymentIntentId = String(getOption(options, "payment_intent_id") || "").trim();

  if (!paymentIntentId.startsWith("pi_")) {
    return ephemeral("Invalid PaymentIntent ID. It should start with `pi_`.");
  }

  const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);

  if (paymentIntent.status !== "requires_capture") {
    return ephemeral(
      `This hold cannot be released because its status is **${paymentIntent.status}**.\n` +
        `Only holds with status **requires_capture** can be cancelled/released.`
    );
  }

  const cancelled = await stripe.paymentIntents.cancel(paymentIntentId);

  return ephemeral(
    `✅ **Hold released/cancelled**\n\n` +
      `PaymentIntent: ${cancelled.id}\n` +
      `Status: ${cancelled.status}`
  );
}

async function handleCaptureHold(options: DiscordOption[]) {
  const paymentIntentId = String(getOption(options, "payment_intent_id") || "").trim();
  const amountRaw = getOption(options, "amount");
  const amount = Number(amountRaw);

  if (!paymentIntentId.startsWith("pi_")) {
    return ephemeral("Invalid PaymentIntent ID. It should start with `pi_`.");
  }

  if (!amount || amount <= 0) {
    return ephemeral("Invalid amount. Example: `/capture-hold payment_intent_id:pi_... amount:200`");
  }

  const amountCents = Math.round(amount * 100);

  const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);

  if (paymentIntent.status !== "requires_capture") {
    return ephemeral(
      `This hold cannot be captured because its status is **${paymentIntent.status}**.\n` +
        `Only holds with status **requires_capture** can be captured.`
    );
  }

  if (amountCents > paymentIntent.amount_capturable) {
    return ephemeral(
      `You cannot capture more than the authorised amount.\n\n` +
        `Requested: **$${amount.toFixed(2)} AUD**\n` +
        `Capturable: **$${(paymentIntent.amount_capturable / 100).toFixed(2)} AUD**`
    );
  }

  const captured = await stripe.paymentIntents.capture(paymentIntentId, {
    amount_to_capture: amountCents,
  });

  return ephemeral(
    `✅ **Hold captured/charged**\n\n` +
      `PaymentIntent: ${captured.id}\n` +
      `Status: ${captured.status}\n` +
      `Amount captured: **$${(captured.amount_received / 100).toFixed(2)} AUD**`
  );
}

export async function GET() {
  return jsonResponse({ ok: true, message: "Discord interactions endpoint is live." });
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

  if (interaction.type !== InteractionType.APPLICATION_COMMAND) {
    return ephemeral("Unsupported interaction type.");
  }

  const userId = interaction.member?.user?.id || interaction.user?.id;

  if (!isUserAllowed(userId)) {
    return ephemeral("You are not authorised to use this command.");
  }

  try {
    requireStripeKey();

    const commandName = interaction.data.name;
    const options = interaction.data.options || [];

    if (commandName === "create-hold") return await handleCreateHold(options);
    if (commandName === "release-hold") return await handleReleaseHold(options);
    if (commandName === "capture-hold") return await handleCaptureHold(options);

    return ephemeral("Unknown command.");
  } catch (error: any) {
    console.error(error);
    return ephemeral(`Error: ${error.message || "Something went wrong."}`);
  }
}
