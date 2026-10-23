# Stripe Damage Deposit Discord Tool

This is a Vercel-ready Next.js app that lets you run Discord slash commands to create, release, and capture Stripe manual-capture damage deposit holds.

## Commands

```text
/create-hold amount:300 name:John
/release-hold payment_intent_id:pi_...
/capture-hold payment_intent_id:pi_... amount:200
```

## How it works

- `/create-hold` takes an AUD amount and `name`, then privately shows seven clickable checkout dates: today and the next six calendar days in Sydney. The selector expires after two hours and rechecks the date window on selection. Selecting a date creates a single-use Stripe Payment Link using `capture_method: manual`. No Hostaway or redirect link is needed. This date limit does not extend Stripe's actual authorisation deadline; a reminder two days after checkout can fall after expiry.
- The guest enters card details and Stripe authorises the card.
- Stripe shows its own confirmation page: “Your $300.00 AUD damage deposit hold has been authorised. Funds have not been collected. You can screenshot this confirmation and close this page.” The amount matches the hold.
- The existing `checkout.session.completed` webhook saves the hold for the Discord dropdown, including Stripe's actual capture deadline. Configure this event at `/api/stripe-webhook` and set `STRIPE_WEBHOOK_SECRET` plus `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`.
- You can later release the hold by cancelling the PaymentIntent.
- You can charge part or all of the hold by capturing the PaymentIntent.
- Payment Links do not expose Checkout's `request_extended_authorization` setting. Use the actual capture deadline shown by the bot; do not assume a 30-day hold.
- Creation acknowledges Discord immediately, then sends the link privately when Stripe finishes. Retries of the same interaction reuse Stripe objects via idempotency keys.

## Checkout reminders

- Create holds in a server channel where the bot can send messages. The original creator and channel are saved with the checkout date.
- At 10 am Australia/Sydney two calendar days after checkout (including daylight-saving changes), the bot sends one reminder in **#stripe-payments** and mentions only the creator, regardless of which channel created the hold. This also applies to already queued reminders. The destination is configured in `lib/reminder-destination.ts`. A protected hourly Vercel Cron job processes due reminders; temporary failures are retried on later runs.
- Stripe is checked immediately before sending. Captured, released, or expired holds are skipped. Existing holds without a checkout date/channel cannot be scheduled retroactively.
- **Release hold** cancels the authorisation. **Capture amount…** opens a form; submitting it charges that AUD amount and releases the remainder. Both actions retain the existing authorised-user checks and recheck Stripe's current state.
- Completed actions remove the pending reminder and remove the message's buttons. Redis locks coordinate clicks with reminder delivery, Stripe idempotency keys protect retries, and saved reminder IDs survive webhook retries.
- Set a random `CRON_SECRET` (at least 32 characters) in Vercel's Production environment before deployment. Vercel sends it as a Bearer token to `/api/cron/hold-reminders`. `vercel.json` registers the hourly schedule. Cron Jobs must be enabled in the project.
- Required environment variables: `DISCORD_BOT_TOKEN`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`, and `CRON_SECRET`, plus the Discord command variables below.

## Local setup

```bash
npm install
cp .env.example .env.local
npm run dev
```

Fill in `.env.local` with:

```env
STRIPE_SECRET_KEY=sk_test_or_sk_live_here
DISCORD_PUBLIC_KEY=your_discord_public_key_here
DISCORD_BOT_TOKEN=your_discord_bot_token_here
DISCORD_APPLICATION_ID=your_discord_application_id_here
DISCORD_GUILD_ID=optional_server_id_for_fast_testing
AUTHORIZED_DISCORD_USER_IDS=optional_user_id_1,optional_user_id_2
```

Do not commit `.env.local`.

## Vercel setup

1. Push this folder to GitHub.
2. Import the repo into Vercel.
3. Add the environment variables in Vercel Project Settings.
4. Deploy.
5. Set the Discord Interactions Endpoint URL to:

```text
https://YOUR-VERCEL-DOMAIN.vercel.app/api/discord
```

## Register Discord commands

After setting your environment variables locally, run:

```bash
npm run register:commands
```

If `DISCORD_GUILD_ID` is set, the commands are registered to that one server and appear quickly.
If `DISCORD_GUILD_ID` is blank, they are global commands and can take longer to appear.

## Security

Set `AUTHORIZED_DISCORD_USER_IDS` so only you or your team can run payment commands.

Example:

```env
AUTHORIZED_DISCORD_USER_IDS=123456789012345678,987654321098765432
```

If this is blank, anyone who can use the slash commands in the server can use them.
