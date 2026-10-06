// Genji Ball Discord bot: a Cloudflare Worker. Discord sends slash commands and button presses to
// it over HTTPS (the "Interactions Endpoint URL"), and a cron runs the reminders and refreshes.

import { Discord, EPHEMERAL, InteractionType, ResponseType, verifyRequest } from "./discord.js";
import { parseButton, renderLeaderboard } from "./leaderboard.js";
import { Site } from "./site.js";
import { autocompletePlayers, renderStats } from "./stats.js";
import { sendReminders, syncTourneys, toggleReminder } from "./tourneys.js";

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

/**
 * Slash command options as { name: value }, with the subcommand path ("cancel") and the option
 * being typed in, for autocomplete.
 */
export function optionsOf(data) {
  const options = {};
  let sub = null;
  let focused = null;
  const walk = (list = []) => {
    for (const o of list) {
      if (o.type === 1 || o.type === 2) {
        sub = o.name;
        walk(o.options);
      } else {
        options[o.name] = o.value;
        if (o.focused) focused = o;
      }
    }
  };
  walk(data?.options);
  return { sub, options, focused };
}

const refreshMinutes = (env) => Math.max(1, Number(env.LEADERBOARD_REFRESH_MINUTES) || 5);
const tourneyMinutes = (env) => Math.max(1, Number(env.TOURNEY_REFRESH_MINUTES) || 5);

/**
 * /setup leaderboard: posts the live leaderboard in a channel, or refreshes the one already there.
 * The cron keeps it up to date. One per channel; delete the message to stop it.
 */
async function setupLeaderboard(env, discord, site, interaction, channelId) {
  const { message } = await renderLeaderboard(site, "eu", 1, { live: true, refreshMinutes: refreshMinutes(env) });
  const existing = await env.DB.prepare("SELECT message_id FROM boards WHERE channel_id = ?").bind(channelId).first();
  let messageId = null;
  if (existing) {
    try {
      await discord.editMessage(channelId, existing.message_id, message);
      messageId = existing.message_id;
    } catch (e) {
      if (e.status !== 404) throw e; // deleted: post a new one
    }
  }
  if (!messageId) {
    try {
      messageId = (await discord.sendMessage(channelId, message)).id;
    } catch (e) {
      if (e.status === 403 || e.status === 404) {
        return `I can't post in <#${channelId}>. Give me **View Channel**, **Send Messages** and **Embed Links** there.`;
      }
      throw e;
    }
  }
  await env.DB.prepare("INSERT OR REPLACE INTO boards (channel_id, guild_id, message_id) VALUES (?, ?, ?)")
    .bind(channelId, interaction.guild_id, messageId)
    .run();
  return `The live leaderboard is in <#${channelId}>. It updates every ${refreshMinutes(env)} minutes. Delete the message to stop it.`;
}

/** Something went wrong after we deferred: say so instead of leaving "thinking…" forever. */
async function failSoftly(discord, token, error) {
  console.error(error);
  await discord.editOriginal(token, { content: "Something went wrong talking to the site or Discord. Try again in a minute.", embeds: [], components: [] }).catch(() => null);
}

const STAFF_COMMANDS = new Set(["setup", "leaderboard"]);
const ADMINISTRATOR = 1n << 3n;

/** Staff: has the STAFF_ROLE_ID role, or is a server admin (so the owner can't lock themselves out). */
export function isStaff(env, member) {
  if (!member) return false;
  const staffRole = (env.STAFF_ROLE_ID ?? "").trim();
  if (staffRole && member.roles?.includes(staffRole)) return true;
  try {
    return (BigInt(member.permissions ?? "0") & ADMINISTRATOR) !== 0n;
  } catch {
    return false;
  }
}

async function handleCommand(env, ctx, interaction) {
  const discord = new Discord(env);
  const site = new Site(env);
  const { options } = optionsOf(interaction.data);
  const name = interaction.data.name;

  if (STAFF_COMMANDS.has(name)) {
    if (!interaction.guild_id) {
      return json({ type: ResponseType.MESSAGE, data: { content: "Use this in the server, not in DMs.", flags: EPHEMERAL } });
    }
    if (!isStaff(env, interaction.member)) {
      return json({ type: ResponseType.MESSAGE, data: { content: "Only **Staff** can use this command. Everyone can use `/stats`.", flags: EPHEMERAL } });
    }
  }

  if (name === "leaderboard") {
    ctx.waitUntil(
      (async () => {
        try {
          const { message } = await renderLeaderboard(site, options.region, options.page);
          await discord.editOriginal(interaction.token, message);
        } catch (e) {
          await failSoftly(discord, interaction.token, e);
        }
      })(),
    );
    return json({ type: ResponseType.DEFERRED_MESSAGE });
  }

  if (name === "stats") {
    ctx.waitUntil(
      (async () => {
        try {
          await discord.editOriginal(interaction.token, await renderStats(site, options.player, options.region));
        } catch (e) {
          await failSoftly(discord, interaction.token, e);
        }
      })(),
    );
    return json({ type: ResponseType.DEFERRED_MESSAGE });
  }

  if (name === "setup") {
    ctx.waitUntil(
      (async () => {
        try {
          const reply = await setupLeaderboard(env, discord, site, interaction, options.channel ?? interaction.channel_id);
          await discord.editOriginal(interaction.token, { content: reply, allowed_mentions: { parse: [] } });
        } catch (e) {
          await failSoftly(discord, interaction.token, e);
        }
      })(),
    );
    return json({ type: ResponseType.DEFERRED_MESSAGE, data: { flags: EPHEMERAL } });
  }

  if (name === "host") {
    // The old /host sign-ups, until the commands are registered again without it.
    const channel = (env.TOURNEY_CHANNEL_ID ?? "").trim();
    const content =
      `Tourneys are made on genjiball.us now, and players sign up there. Admins create them on the site's admin page; ` +
      `I post each one${channel ? ` in <#${channel}>` : ""} with a 🔔 Remind me button.`;
    return json({ type: ResponseType.MESSAGE, data: { content, flags: EPHEMERAL, allowed_mentions: { parse: [] } } });
  }

  return json({ type: ResponseType.MESSAGE, data: { content: "I don't know that command.", flags: EPHEMERAL } });
}

async function handleButton(env, ctx, interaction) {
  const remind = /^tr:(\d+)$/.exec(interaction.data.custom_id ?? "");
  if (remind) {
    // Only the bot's own D1: quick enough to answer straight away.
    const content = await toggleReminder(env, new Site(env), interaction, Number(remind[1]));
    return json({ type: ResponseType.MESSAGE, data: { content, flags: EPHEMERAL, allowed_mentions: { parse: [] } } });
  }
  const target = parseButton(interaction.data.custom_id);
  if (!target) return json({ type: ResponseType.DEFERRED_UPDATE });
  const discord = new Discord(env);
  const site = new Site(env);
  // On the live board, a button opens a private copy for the presser, so the channel's board stays
  // put for everyone else. Anywhere else (a /leaderboard post, a private copy) it flips the message.
  const live = interaction.message?.id
    ? await env.DB.prepare("SELECT 1 FROM boards WHERE message_id = ?").bind(interaction.message.id).first()
    : null;
  ctx.waitUntil(
    (async () => {
      try {
        const { message } = await renderLeaderboard(site, target.region, target.page);
        await discord.editOriginal(interaction.token, message);
      } catch (e) {
        if (live) await failSoftly(discord, interaction.token, e);
        else console.error(e);
      }
    })(),
  );
  return json(live ? { type: ResponseType.DEFERRED_MESSAGE, data: { flags: EPHEMERAL } } : { type: ResponseType.DEFERRED_UPDATE });
}

async function handleAutocomplete(env, interaction) {
  const { focused, options } = optionsOf(interaction.data);
  let choices = [];
  if (focused?.name === "player") choices = await autocompletePlayers(new Site(env), focused.value, options.region);
  return json({ type: ResponseType.AUTOCOMPLETE, data: { choices } });
}

/** Re-renders every live leaderboard, oldest refresh first, as far as this run's budget goes. */
async function refreshBoards(env, discord, site, budget) {
  const { results } = await env.DB.prepare("SELECT * FROM boards ORDER BY refreshed_at").all();
  for (const b of results) {
    if (budget() < 4) return;
    try {
      const { message } = await renderLeaderboard(site, "eu", 1, { live: true, refreshMinutes: refreshMinutes(env) });
      await discord.editMessage(b.channel_id, b.message_id, message);
      await env.DB.prepare("UPDATE boards SET refreshed_at = ? WHERE channel_id = ?").bind(Date.now(), b.channel_id).run();
    } catch (e) {
      // The message or channel is gone, or we lost access: stop refreshing it.
      if (e.status === 404 || e.status === 403) await env.DB.prepare("DELETE FROM boards WHERE channel_id = ?").bind(b.channel_id).run();
      else console.error(e);
    }
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/") {
      return new Response("Genji Ball bot is running. Discord talks to it at /interactions.");
    }
    if (request.method !== "POST" || (url.pathname !== "/interactions" && url.pathname !== "/")) {
      return new Response("Not found", { status: 404 });
    }
    const { ok, body } = await verifyRequest(request, env.DISCORD_PUBLIC_KEY);
    if (!ok) return new Response("Bad signature", { status: 401 });
    const interaction = JSON.parse(body);

    switch (interaction.type) {
      case InteractionType.PING:
        return json({ type: ResponseType.PONG });
      case InteractionType.COMMAND:
        return handleCommand(env, ctx, interaction);
      case InteractionType.COMPONENT:
        return handleButton(env, ctx, interaction);
      case InteractionType.AUTOCOMPLETE:
        return handleAutocomplete(env, interaction);
      default:
        return new Response("Unknown interaction", { status: 400 });
    }
  },

  async scheduled(event, env, ctx) {
    // The free plan allows 50 outgoing requests per run; keep a margin.
    const discord = new Discord(env, 45);
    const site = new Site(env);
    const budget = () => discord.left - site.calls;
    const now = event.scheduledTime ?? Date.now();
    await sendReminders(env, discord, site, budget, now).catch((e) => console.error("reminders", e));
    const minute = new Date(now).getUTCMinutes();
    if (minute % tourneyMinutes(env) === 0) {
      // 2 site requests, then 1 Discord request per post that changed.
      await syncTourneys(env, discord, site, budget).catch((e) => console.error("tourneys", e));
    }
    if (minute % refreshMinutes(env) === 0) {
      // Each board costs up to 2 site requests and 1 Discord request, all inside the run's budget.
      await refreshBoards(env, discord, site, budget).catch((e) => console.error("boards", e));
    }
  },
};
