// Registers the slash commands (/gr …) with Discord. Run it once, and again after changing
// scripts/commands.js:
//
//   npm run register
//
// It asks for the bot token (Developer Portal → your app → Bot → Reset Token). Or set
// DISCORD_TOKEN first to skip the question.
//
// The commands go to the Genji Ball server only (DISCORD_GUILD_ID below), where they show up at
// once. It also removes any old global commands (/stats, /host, /setup, /leaderboard), so there are
// no doubles.

import { readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { commands } from "./commands.js";

const toml = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
const fromToml = (key) => new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, "m").exec(toml)?.[1];

const appId = process.env.DISCORD_APPLICATION_ID || fromToml("DISCORD_APPLICATION_ID");
const guildId = process.env.DISCORD_GUILD_ID || fromToml("DISCORD_GUILD_ID");
let token = process.env.DISCORD_TOKEN;
if (!token) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  token = (await rl.question("Paste the bot token and press Enter: ")).trim();
  rl.close();
}
if (!token || !appId || !guildId) {
  console.error("Missing the bot token, DISCORD_APPLICATION_ID or DISCORD_GUILD_ID (in wrangler.toml).");
  process.exit(1);
}

async function put(path, body) {
  const res = await fetch(`https://discord.com/api/v10${path}`, {
    method: "PUT",
    headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) {
    console.error(`Discord said ${res.status}:`, JSON.stringify(data, null, 2));
    process.exit(1);
  }
  return data;
}

const registered = await put(`/applications/${appId}/guilds/${guildId}/commands`, commands);
await put(`/applications/${appId}/commands`, []);
console.log(`Done: /${registered.map((c) => c.name).join(", /")} is in your server (old global commands removed).`);
