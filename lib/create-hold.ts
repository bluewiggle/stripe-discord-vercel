import Stripe from "stripe";

export async function createHoldLink(
  stripe: Stripe,
  input: { amount: number; apartment: string; interactionId: string; userId?: string }
) {
  const amountCents = Math.round(input.amount * 100);
  if (!Number.isFinite(input.amount) || amountCents < 50 || amountCents > 99999999) {
    throw new Error("Enter an amount between $0.50 and $999,999.99 AUD.");
  }
  const note = input.apartment.trim();
  if (!note || note.length > 500) {
    throw new Error("Enter an apartment name between 1 and 500 characters.");
  }
  const amount = (amountCents / 100).toFixed(2);
  const metadata = {
    type: "damage_deposit_hold",
    note,
    created_from: "discord",
    created_by: input.userId || "",
  };
  // Repeated delivery of the same Discord interaction reuses both objects.
  const idempotencyKey = `discord-hold-${input.interactionId}`;
  const product = await stripe.products.create(
    {
      name: `$${amount} AUD Damage Deposit Authorisation`,
      description: "Temporary card authorisation hold. This is not captured unless required.",
      default_price_data: { currency: "aud", unit_amount: amountCents },
      metadata,
    },
    { idempotencyKey: `${idempotencyKey}-product` }
  );
  const priceId = typeof product.default_price === "string"
    ? product.default_price
    : product.default_price?.id;
  if (!priceId) throw new Error("Stripe did not return a price for this hold.");

  const link = await stripe.paymentLinks.create(
    {
      line_items: [{ price: priceId, quantity: 1 }],
      payment_method_types: ["card"],
      // Stripe copies Payment Link metadata to checkout.session.completed.
      metadata,
      payment_intent_data: {
        capture_method: "manual",
        description: "Damage deposit authorisation",
        metadata,
      },
      restrictions: { completed_sessions: { limit: 1 } },
      after_completion: {
        type: "hosted_confirmation",
        hosted_confirmation: {
          custom_message: `Your $${amount} AUD damage deposit hold has been authorised. Funds have not been collected. You can screenshot this confirmation and close this page.`,
        },
      },
      custom_text: {
        submit: {
          message: `This authorises a $${amount} AUD temporary hold only. Funds will not be collected automatically.`,
        },
      },
    },
    { idempotencyKey: `${idempotencyKey}-link` }
  );

  return `✅ **Damage deposit hold link created**\n\n` +
    `Amount: **$${amount} AUD**\n` +
    `Apartment: **${note}**\n` +
    `Link: ${link.url}\n\n` +
    "The guest will see their confirmation on Stripe. This link can be completed once.";
}
