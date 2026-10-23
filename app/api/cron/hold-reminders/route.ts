import { timingSafeEqual } from "node:crypto";
import Stripe from "stripe";
import { sendDueReminders } from "@/lib/hold-reminders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  const supplied = req.headers.get("authorization") || "";
  const expected = `Bearer ${secret}`;
  if (!secret || Buffer.byteLength(supplied) !== Buffer.byteLength(expected) ||
      !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) {
    return new Response("Unauthorized", { status: 401 });
  }
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY as string, { timeout: 10000, maxNetworkRetries: 0 });
  const result = await sendDueReminders(stripe);
  return Response.json(result, { status: result.failed ? 503 : 200 });
}
