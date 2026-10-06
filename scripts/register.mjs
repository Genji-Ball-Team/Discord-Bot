// Registers the slash commands with Discord. Run it once after setup, and again after changing
// scripts/commands.js:
//
//   DISCORD_TOKEN=... DISCORD_APPLICATION_ID=... node scripts/register.mjs
//
// On Windows PowerShell:
//   $env:DISCORD_TOKEN="..."; $env:DISCORD_APPLICATION_ID="..."; node scripts/register.mjs
//
// Add DISCORD_GUILD_ID (your server's id) to make them show up in that server instantly while
// testing. Without it they're global, which can take a few minutes to appear.

import { commands } from "./commands.js";

const token = process.env.DISCORD_TOKEN;
const appId = process.env.DISCORD_APPLICATION_ID;
const guildId = process.env.DISCORD_GUILD_ID;
if (!token || !appId) {
  console.error("Set DISCORD_TOKEN and DISCORD_APPLICATION_ID first (see the top of this file).");
  process.exit(1);
}

const path = guildId ? `/applications/${appId}/guilds/${guildId}/commands` : `/applications/${appId}/commands`;
const res = await fetch(`https://discord.com/api/v10${path}`, {
  method: "PUT",
  headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
  body: JSON.stringify(commands),
});
const data = await res.json();
if (!res.ok) {
  console.error(`Discord said ${res.status}:`, JSON.stringify(data, null, 2));
  process.exit(1);
}
console.log(`Registered ${data.length} commands${guildId ? ` in server ${guildId}` : " globally"}: ${data.map((c) => "/" + c.name).join(", ")}`);
