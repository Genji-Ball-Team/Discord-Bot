// The Worker: Discord sends every slash command and button press to /interactions, and the cron
// runs every minute: tournament DMs and lists, the site's new tourneys, tournament results, the
// live leaderboards.
//
// All commands are under /gr. Everyone can use /gr stats; the rest is for Staff (STAFF_ROLE_ID, or
// server admins).

import { Discord, EPHEMERAL, InteractionType, NO_PINGS, ResponseType, verifyRequest } from "./discord.js";
import { parseButton, renderLeaderboard } from "./leaderboard.js";
import { postResults } from "./results.js";
import { Site, signsUp } from "./site.js";
import { autocompletePlayers, renderStats } from "./stats.js";
import {
  confirmButton,
  formName,
  parseTourneyButton,
  refreshPostById,
  runTournaments,
  signupButton,
  siteSignup,
  syncTourneys,
  tourneyMinutes,
} from "./tournament.js";

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
const privateReply = (content) => json({ type: ResponseType.MESSAGE, data: { content, flags: EPHEMERAL, allowed_mentions: NO_PINGS } });

/** `/gr <group> <sub> options…` → { path: ["host", "tournament"], options, focused }. */
export function optionsOf(data) {
  const path = [];
  const options = {};
  let focused = null;
  const walk = (list = []) => {
    for (const o of list) {
      if (o.type === 1 || o.type === 2) {
        path.push(o.name);
        walk(o.options);
      } else {
        options[o.name] = o.value;
        if (o.focused) focused = o;
      }
    }
  };
  walk(data?.options);
  return { path, options, focused };
}

const refreshMinutes = (env) => Math.max(1, Number(env.LEADERBOARD_REFRESH_MINUTES) || 5);

const ADMINISTRATOR = 1n << 3n;

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

async function setupLeaderboard(env, discord, site, interaction, channelId) {
  const { message } = await renderLeaderboard(site, "eu", 1, { live: true, refreshMinutes: refreshMinutes(env) });
  const existing = await env.DB.prepare("SELECT message_id FROM boards WHERE channel_id = ?").bind(channelId).first();
  let messageId = null;
  if (existing) {
    try {
      await discord.editMessage(channelId, existing.message_id, message);
      messageId = existing.message_id;
    } catch (e) {
      if (e.status !== 404) throw e;
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

async function failSoftly(discord, token, error) {
  console.error(error);
  await discord
    .editOriginal(token, { content: "Something went wrong talking to the site or Discord. Try again in a minute.", embeds: [], components: [] })
    .catch(() => null);
}

/** Runs `work` after answering Discord (it wants an answer within 3 seconds), then edits the answer. */
function deferred(ctx, discord, interaction, work, { ephemeral = false } = {}) {
  ctx.waitUntil(
    (async () => {
      try {
        const result = await work();
        const message = typeof result === "string" ? { content: result, allowed_mentions: NO_PINGS } : result;
        await discord.editOriginal(interaction.token, message);
      } catch (e) {
        await failSoftly(discord, interaction.token, e);
      }
    })(),
  );
  return json({ type: ResponseType.DEFERRED_MESSAGE, data: ephemeral ? { flags: EPHEMERAL } : undefined });
}

async function handleCommand(env, ctx, interaction) {
  if (interaction.data.name !== "gr") return privateReply("I don't know that command. All my commands start with `/gr`.");
  const discord = new Discord(env);
  const site = new Site(env);
  const { path, options } = optionsOf(interaction.data);
  const command = path.join(" ");

  if (command === "stats") {
    return deferred(ctx, discord, interaction, () => renderStats(site, options.player, options.region));
  }

  // Everything else is staff only, and only in the server.
  if (!interaction.guild_id) return privateReply("Use this in the server, not in DMs.");
  if (!isStaff(env, interaction.member)) return privateReply("Only **Staff** can use this. Everyone can use `/gr stats`.");

  switch (command) {
    case "leaderboard":
      return deferred(ctx, discord, interaction, async () => (await renderLeaderboard(site, options.region, options.page)).message);
    case "setup leaderboard":
      return deferred(ctx, discord, interaction, () => setupLeaderboard(env, discord, site, interaction, options.channel ?? interaction.channel_id), {
        ephemeral: true,
      });
    default:
      return privateReply("I don't know that command.");
  }
}

async function handleButton(env, ctx, interaction) {
  const tourney = parseTourneyButton(interaction.data.custom_id);
  if (tourney?.action === "conf") {
    const message = await confirmButton(env, interaction, tourney.id);
    return json({ type: ResponseType.UPDATE_MESSAGE, data: message });
  }
  if (tourney && signsUp(env) && (tourney.action === "unreg" || tourney.action === "who")) {
    return siteSignupReply(env, ctx, interaction, tourney);
  }
  if (tourney) {
    const { reply, changed, form } = await signupButton(env, interaction, tourney.action, tourney.id);
    if (form) return json({ type: ResponseType.MODAL, data: form });
    if (changed) ctx.waitUntil(refreshPostById(env, new Discord(env), tourney.id).catch((e) => console.error("refresh post", e)));
    return privateReply(reply);
  }

  const target = parseButton(interaction.data.custom_id);
  if (!target) return json({ type: ResponseType.DEFERRED_UPDATE });
  const discord = new Discord(env);
  const site = new Site(env);
  // The live board stays the same for everyone: its buttons open a private copy.
  const live = interaction.message?.id ? await env.DB.prepare("SELECT 1 FROM boards WHERE message_id = ?").bind(interaction.message.id).first() : null;
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

/** A sign-up that calls the site (one list with it): answered privately once the site has. */
function siteSignupReply(env, ctx, interaction, tourney, ign) {
  const discord = new Discord(env);
  return deferred(
    ctx,
    discord,
    interaction,
    async () => {
      const { reply, changed } = await siteSignup(env, new Site(env), interaction, tourney.action, tourney.id, ign);
      if (changed) await refreshPostById(env, discord, tourney.id).catch((e) => console.error("refresh post", e));
      return reply;
    },
    { ephemeral: true },
  );
}

/** Register's in-game name form, sent. */
function handleForm(env, ctx, interaction) {
  const tourney = parseTourneyButton(interaction.data?.custom_id);
  if (tourney?.action !== "ign") return privateReply("I don't know that form.");
  return siteSignupReply(env, ctx, interaction, tourney, formName(interaction));
}

async function handleAutocomplete(env, interaction) {
  const { focused, options } = optionsOf(interaction.data);
  let choices = [];
  if (focused?.name === "player") choices = await autocompletePlayers(new Site(env), focused.value, options.region);
  return json({ type: ResponseType.AUTOCOMPLETE, data: { choices } });
}

async function refreshBoards(env, discord, site, budget) {
  const { results } = await env.DB.prepare("SELECT * FROM boards ORDER BY refreshed_at").all();
  for (const b of results) {
    if (budget() < 4) return;
    try {
      const { message } = await renderLeaderboard(site, "eu", 1, { live: true, refreshMinutes: refreshMinutes(env) });
      await discord.editMessage(b.channel_id, b.message_id, message);
      await env.DB.prepare("UPDATE boards SET refreshed_at = ? WHERE channel_id = ?").bind(Date.now(), b.channel_id).run();
    } catch (e) {
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
      case InteractionType.MODAL_SUBMIT:
        return handleForm(env, ctx, interaction);
      default:
        return new Response("Unknown interaction", { status: 400 });
    }
  },

  async scheduled(event, env) {
    // The free plan allows 50 outgoing requests a run: keep a few spare.
    const discord = new Discord(env, 45);
    const site = new Site(env);
    const budget = () => discord.left - site.calls;
    const now = event.scheduledTime ?? Date.now();
    const minute = new Date(now).getUTCMinutes();
    // DMs and lists first: they can't wait. Then new or changed tourneys from the site.
    await runTournaments(env, discord, site, budget, now).catch((e) => console.error("tournaments", e));
    if (minute % tourneyMinutes(env) === 0) {
      await syncTourneys(env, discord, site, budget, now).catch((e) => console.error("tourney sync", e));
    }
    // Tournament results: the site rates matches every 10 minutes, so every 5 is soon enough.
    if (minute % 5 === 2) {
      await postResults(env, discord, site, budget).catch((e) => console.error("results", e));
    }
    if (minute % refreshMinutes(env) === 0) {
      await refreshBoards(env, discord, site, budget).catch((e) => console.error("boards", e));
    }
  },
};
