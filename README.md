# Stripe Damage Deposit Discord Tool

This is a Vercel-ready Next.js app that lets you run Discord slash commands to create, release, and capture Stripe manual-capture damage deposit holds.

## Commands

```text
/create-hold amount:300 portal_link:https://your-guest-portal-link.com
/release-hold payment_intent_id:pi_...
/capture-hold payment_intent_id:pi_... amount:200
```

## How it works

- `/create-hold` creates a Stripe Checkout Session using `capture_method: manual`.
- The guest enters card details and Stripe authorises the card.
- You can later release the hold by cancelling the PaymentIntent.
- You can charge part or all of the hold by capturing the PaymentIntent.

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
