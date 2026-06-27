import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });

// Wipes ALL globally-registered slash commands for this application by PUTting
// an empty command list to the global endpoint. Your guild commands (registered
// when DISCORD_GUILD_ID is set) are a separate scope and are left untouched.
//
// Run once:  node scripts/clear-global-commands.mjs
// The duplicates disappear from the picker within a minute or so (the client
// may need a refresh: Ctrl/Cmd+R in the Discord desktop app).

async function main() {
  const applicationId = process.env.DISCORD_APPLICATION_ID;
  const botToken = process.env.DISCORD_BOT_TOKEN;

  if (!applicationId || !botToken) {
    throw new Error("Missing DISCORD_APPLICATION_ID or DISCORD_BOT_TOKEN");
  }

  const url = `https://discord.com/api/v10/applications/${applicationId}/commands`;

  const response = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bot ${botToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify([]), // empty set = delete all global commands
  });

  const data = await response.json();

  if (!response.ok) {
    console.error(data);
    throw new Error("Failed to clear global commands");
  }

  console.log("Global commands cleared. Remaining global commands:", data.length);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
