import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });

const commands = [
  {
    name: "create-hold",
    description: "Create a Stripe damage deposit authorisation hold link",
    options: [
      { name: "amount", description: "Hold amount in AUD, e.g. 300", type: 10, required: true, min_value: 0.5, max_value: 999999.99 },
      {
        name: "name",
        description: "Name for this hold, e.g. John Smith",
        type: 3,
        required: true,
        min_length: 1,
        max_length: 500,
      },
      {
        name: "checkout_date",
        description: "Checkout date (DD/MM/YYYY), e.g. 28/10/2026. Reminder two days later at 10 am Sydney time.",
        type: 3,
        required: true,
        min_length: 10,
        max_length: 10,
      },
    ],
  },
  {
    name: "release-hold",
    description: "Release/cancel an uncaptured Stripe authorisation hold",
    options: [
      { name: "payment_intent_id", description: "Start typing to search saved holds, or paste a PaymentIntent ID (pi_...)", type: 3, required: true, autocomplete: true },
    ],
  },
  {
    name: "capture-hold",
    description: "Capture/charge part or all of a Stripe authorisation hold",
    options: [
      { name: "payment_intent_id", description: "Start typing to search saved holds, or paste a PaymentIntent ID (pi_...)", type: 3, required: true, autocomplete: true },
      { name: "amount", description: "Amount to capture in AUD, e.g. 200", type: 10, required: true },
    ],
  },
];

async function main() {
  const applicationId = process.env.DISCORD_APPLICATION_ID;
  const botToken = process.env.DISCORD_BOT_TOKEN;
  const guildId = process.env.DISCORD_GUILD_ID;

  if (!applicationId || !botToken) {
    throw new Error("Missing DISCORD_APPLICATION_ID or DISCORD_BOT_TOKEN");
  }

  const url = guildId
    ? `https://discord.com/api/v10/applications/${applicationId}/guilds/${guildId}/commands`
    : `https://discord.com/api/v10/applications/${applicationId}/commands`;

  const response = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bot ${botToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(commands),
  });

  const data = await response.json();

  if (!response.ok) {
    console.error(data);
    throw new Error("Failed to register commands");
  }

  console.log(guildId ? "Guild commands registered:" : "Global commands registered:");
  console.log(JSON.stringify(data, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
