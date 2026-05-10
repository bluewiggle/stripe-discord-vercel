import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });

const commands = [
  {
    name: "create-hold",
    description: "Create a Stripe damage deposit authorisation hold link",
    options: [
      {
        name: "amount",
        description: "Hold amount in AUD, e.g. 300",
        type: 10,
        required: true,
      },
      {
        name: "hostaway_portal_link",
        description: "Guest portal link to redirect to after checkout",
        type: 3,
        required: true,
      },
    ],
  },
  {
    name: "release-hold",
    description: "Release/cancel an uncaptured Stripe authorisation hold",
    options: [
      {
        name: "payment_intent_id",
        description: "Stripe PaymentIntent ID starting with pi_",
        type: 3,
        required: true,
      },
    ],
  },
  {
    name: "capture-hold",
    description: "Capture/charge part or all of a Stripe authorisation hold",
    options: [
      {
        name: "payment_intent_id",
        description: "Stripe PaymentIntent ID starting with pi_",
        type: 3,
        required: true,
      },
      {
        name: "amount",
        description: "Amount to capture in AUD, e.g. 200",
        type: 10,
        required: true,
      },
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
