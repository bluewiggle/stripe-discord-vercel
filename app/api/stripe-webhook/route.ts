import { NextRequest } from "next/server";
import Stripe from "stripe";
import { saveHold } from "@/lib/holds";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY as string);

export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  const signature = req.headers.get("stripe-signature");
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!signature || !webhookSecret) {
    return new Response("Missing signature or webhook secret", { status: 400 });
  }

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
  } catch (error: any) {
    console.error("[stripe-webhook] signature verification failed:", error.message);
    return new Response(`Webhook signature verification failed: ${error.message}`, { status: 400 });
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object as Stripe.Checkout.Session;

    if (session.metadata?.type !== "damage_deposit_hold") {
      return new Response("ok", { status: 200 });
    }

    const paymentIntentId =
      typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id;

    if (!paymentIntentId) {
      console.error("[stripe-webhook] checkout.session.completed with no payment_intent:", session.id);
      return new Response("ok", { status: 200 });
    }

    try {
      await saveHold({
        paymentIntentId,
        amount: (session.amount_total ?? 0) / 100,
        note: session.metadata?.note ?? "",
        portalLink: session.metadata?.guest_portal_link ?? "",
        createdAt: Date.now(),
      });
      console.log(`[stripe-webhook] saved hold for ${paymentIntentId}`);
    } catch (error) {
      console.error("[stripe-webhook] failed to save hold:", error);
      return new Response("Failed to save hold", { status: 500 });
    }
  }

  return new Response("ok", { status: 200 });
}