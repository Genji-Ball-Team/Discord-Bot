// Rank roles. Staff link a member to their genjiball.us player (/gr link); the bot then gives them the
// role of their tier, the higher of their EU and NA ones (RANK_ROLES), or UNRANKED_ROLE_ID below the
// first tier or unrated. Every RANK_REFRESH_MINUTES it reads the server's members (one request, with
// the Server Members intent) and every linked player's tiers (one site request, `/api/tiers`), and
// fixes whoever's role is wrong: a climb or drop, a role changed by hand, someone who rejoined. Only
// these roles are ever added or removed, one at a time, never the member's whole list. A climb is
// posted in RANKUP_CHANNEL_ID, pinging nobody.
//
// Titles (God, Demigod) are won in the 1v1 tourney and given by Staff as roles per region
// (GOD_ROLE_IDS, DEMIGOD_ROLE_IDS). The bot doesn't change them: it notes which linked players have
// one, for the leaderboards. The site reads them from `GET /titles` (genjiball-ranked
// src/site/titles.ts), and `/gr leaderboard` from the site's `/api/titles`.

import { NO_PINGS, lostAccess } from "./discord.js";
import { escapeMarkdown } from "./site.js";
import { minutes } from "./time.js";

export const rankMinutes = (env) => minutes(env.RANK_REFRESH_MINUTES);

/** `"a=1, b=2"` → [["a", "1"], ["b", "2"]]. */
const pairs = (value) =>
  String(value ?? "")
    .split(",")
    .map((part) => part.split("=").map((s) => s.trim()))
    .filter(([key, id]) => key && /^\d+$/.test(id ?? ""));

/** RANK_ROLES, lowest tier first: `[{ label, roleId }]`, the labels as the site names its tiers. */
export const rankRoles = (env) => pairs(env.RANK_ROLES).map(([label, roleId]) => ({ label, roleId }));
const unrankedRole = (env) => (env.UNRANKED_ROLE_ID ?? "").trim();
const rankupChannel = (env) => (env.RANKUP_CHANNEL_ID ?? "").trim();
const guildOf = (env) => (env.DISCORD_GUILD_ID ?? "").trim();

/** The title roles: `[{ title, region, roleId }]`, God before Demigod. */
export const titleRoles = (env) =>
  [
    ["God", env.GOD_ROLE_IDS],
    ["Demigod", env.DEMIGOD_ROLE_IDS],
  ].flatMap(([title, value]) => pairs(value).map(([region, roleId]) => ({ title, region, roleId })));

export const ranksOn = (env) => rankRoles(env).length > 0 && guildOf(env) !== "";

/** Every role the bot gives or takes: the tiers' and Unranked. */
const managedRoles = (env) => [...rankRoles(env).map((r) => r.roleId), unrankedRole(env)].filter(Boolean);

/** Where a tier label stands in RANK_ROLES, -1 for none (Unranked) or a tier without a role. */
const tierIndex = (env, label) => rankRoles(env).findIndex((r) => r.label === label);

/** A player's rank: their highest tier in any region (`/api/tiers`), or "" for Unranked. */
export function rankOf(env, player) {
  const labels = Object.values(player?.regions ?? {}).map((r) => r.tier?.label);
  const best = labels.reduce((top, label) => (tierIndex(env, label) > tierIndex(env, top) ? label : top), "");
  return tierIndex(env, best) >= 0 ? best : "";
}

const roleFor = (env, rank) => rankRoles(env).find((r) => r.label === rank)?.roleId ?? unrankedRole(env);

/** The role changes that give a member with `has` the rank role `want` and none of the others. */
function changesFor(env, has, want) {
  const remove = managedRoles(env).filter((id) => id !== want && has.includes(id));
  return { add: want && !has.includes(want) ? [want] : [], remove };
}

async function applyChanges(env, discord, userId, { add, remove }) {
  for (const roleId of remove) await discord.removeRole(guildOf(env), userId, roleId);
  for (const roleId of add) await discord.addRole(guildOf(env), userId, roleId);
}

const rankUpMessage = (name, rank) => ({ content: `**${escapeMarkdown(name)}** has ranked up to **${rank}** 🏆`, allowed_mentions: NO_PINGS });

/** Members of the server by user id: their role ids. Null when the run's budget can't read them all. */
async function members(env, discord, budget) {
  const roles = new Map();
  let after = "0";
  for (;;) {
    if (budget() < 2) return null;
    const page = await discord.listMembers(guildOf(env), after);
    for (const m of page) roles.set(m.user.id, m.roles ?? []);
    if (page.length < 1000) return roles;
    after = page.at(-1).user.id;
  }
}

/** `/api/tiers` for these players, by asked id. */
async function tiersOf(site, ids) {
  const found = new Map();
  for (let i = 0; i < ids.length; i += 200) {
    const data = await site.tiers(ids.slice(i, i + 200));
    for (const p of data?.players ?? []) found.set(p.id, p);
  }
  return found;
}

/**
 * The rank check. A run that runs out of budget before everyone is right says so (`ranks_pending` in
 * bot_state), and the next minute's run goes on.
 */
export async function runRanks(env, discord, site, budget, nowMs = Date.now()) {
  if (!ranksOn(env)) return;
  const { results: links } = await env.DB.prepare("SELECT * FROM links ORDER BY linked_at").all();
  await setPending(env, false);
  if (!links.length) return saveTitles(env, []);
  const roles = await members(env, discord, budget);
  if (!roles || budget() < 2 + Math.ceil(links.length / 200)) return setPending(env, true);
  const tiers = await tiersOf(site, links.map((l) => l.player_id));

  const titles = [];
  const updates = [];
  let done = true;
  for (const link of links) {
    const player = tiers.get(link.player_id);
    const has = roles.get(link.user_id);
    // Gone from the site (an admin deleted the player): left as it is until relinked.
    if (!player) continue;
    for (const t of titleRoles(env)) if (has?.includes(t.roleId)) titles.push({ playerId: player.playerId, region: t.region, title: t.title });
    // Not in the server now: their role is put right when they're back.
    if (!has) continue;
    const rank = rankOf(env, player);
    const changes = changesFor(env, has, roleFor(env, rank));
    const climbed = link.rank !== null && rank !== link.rank && tierIndex(env, rank) > tierIndex(env, link.rank) && rankupChannel(env);
    const cost = 2 * (changes.add.length + changes.remove.length) + (climbed ? 2 : 0);
    if (cost && budget() < cost + 1) {
      done = false;
      break;
    }
    try {
      await applyChanges(env, discord, link.user_id, changes);
    } catch (e) {
      // Above the bot's role, or the server's owner: nothing to do but log it.
      if (!lostAccess(e)) throw e;
      console.error(`can't change the rank role of ${link.user_id}`, e);
    }
    const name = player.name ?? link.name;
    if (climbed) {
      await discord.sendMessage(rankupChannel(env), rankUpMessage(name, rank)).catch((e) => {
        if (!lostAccess(e)) throw e;
        console.error(`can't post in ${rankupChannel(env)}`, e);
      });
    }
    if (rank !== link.rank || name !== link.name || player.playerId !== link.player_id) {
      updates.push({ user_id: link.user_id, player_id: player.playerId, name, rank });
    }
  }
  if (updates.length) {
    await env.DB.prepare(
      `UPDATE links SET player_id = json_extract(u.value, '$.player_id'), name = json_extract(u.value, '$.name'), rank = json_extract(u.value, '$.rank')
       FROM json_each(?) u WHERE links.user_id = json_extract(u.value, '$.user_id')`,
    )
      .bind(JSON.stringify(updates))
      .run();
  }
  if (!done) return setPending(env, true);
  await saveTitles(env, titles);
}

function setPending(env, pending) {
  return pending
    ? env.DB.prepare("INSERT OR REPLACE INTO bot_state (key, value) VALUES ('ranks_pending', '1')").run()
    : env.DB.prepare("DELETE FROM bot_state WHERE key = 'ranks_pending'").run();
}

/** Whether the last rank check didn't finish, so this minute's run should go on with it. */
export async function ranksPending(env) {
  return Boolean(await env.DB.prepare("SELECT 1 FROM bot_state WHERE key = 'ranks_pending'").first());
}

async function saveTitles(env, titles) {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM titles"),
    env.DB.prepare(
      `INSERT OR IGNORE INTO titles (player_id, region, title)
       SELECT json_extract(value, '$.playerId'), json_extract(value, '$.region'), json_extract(value, '$.title') FROM json_each(?)`,
    ).bind(JSON.stringify(titles)),
  ]);
}

/** `GET /titles`, for the site: `{ titles: [{ playerId, region, title }] }`. */
export async function listTitles(env) {
  const { results } = await env.DB.prepare("SELECT player_id AS playerId, region, title FROM titles ORDER BY region, title, player_id").all();
  return { titles: results };
}

/** Linked Discord users by site player id, for the leaderboard's @mentions. */
export async function linkedUsers(env, playerIds) {
  if (!playerIds.length) return new Map();
  const { results } = await env.DB.prepare("SELECT user_id, player_id FROM links WHERE player_id IN (SELECT value FROM json_each(?))")
    .bind(JSON.stringify(playerIds))
    .all();
  return new Map(results.map((r) => [r.player_id, r.user_id]));
}

const CANT_CHANGE_ROLES =
  "I can't change their roles. In **Server Settings → Roles**, drag my role above the rank roles and give it **Manage Roles**. " +
  "(Nobody can change the server owner's roles.)";

/**
 * /gr link: links the member to the site player and gives them their rank role at once. `has`: the
 * member's roles, from the command. A player is linked to one member, and a member to one player.
 */
export async function link(env, discord, site, { userId, has, playerId }, nowMs = Date.now()) {
  if (!ranksOn(env)) return "Rank roles aren't set up: `RANK_ROLES` in wrangler.toml is empty.";
  if (!playerId) return "I couldn't find that player on genjiball.us. Pick them from the list as you type.";
  const player = (await site.tiers([playerId]))?.players?.[0];
  if (!player) return "That player isn't on genjiball.us.";
  const taken = await env.DB.prepare("SELECT user_id FROM links WHERE player_id = ? AND user_id != ?").bind(player.playerId, userId).first();
  const name = `**${escapeMarkdown(player.name ?? `#${player.playerId}`)}**`;
  if (taken) return `${name} is already linked to <@${taken.user_id}>. \`/gr unlink\` them first.`;
  const rank = rankOf(env, player);
  try {
    await applyChanges(env, discord, userId, changesFor(env, has, roleFor(env, rank)));
  } catch (e) {
    if (!lostAccess(e)) throw e;
    return CANT_CHANGE_ROLES;
  }
  await env.DB.prepare("INSERT OR REPLACE INTO links (user_id, player_id, name, rank, linked_at) VALUES (?, ?, ?, ?, ?)")
    .bind(userId, player.playerId, player.name ?? "", rank, nowMs)
    .run();
  return `Linked <@${userId}> to ${name} (${site.playerUrl(player.playerId, Object.keys(player.regions)[0] ?? "eu")}). Rank role: **${rank || "Unranked"}**.`;
}

/** /gr unlink: takes the link and the rank role away, back to Unranked. */
export async function unlink(env, discord, { userId, has }) {
  const row = await env.DB.prepare("SELECT player_id FROM links WHERE user_id = ?").bind(userId).first();
  if (!row) return `<@${userId}> isn't linked.`;
  try {
    await applyChanges(env, discord, userId, changesFor(env, has, unrankedRole(env)));
  } catch (e) {
    if (!lostAccess(e)) throw e;
    return CANT_CHANGE_ROLES;
  }
  await env.DB.batch([
    env.DB.prepare("DELETE FROM links WHERE user_id = ?").bind(userId),
    env.DB.prepare("DELETE FROM titles WHERE player_id = ?").bind(row.player_id),
  ]);
  return `Unlinked <@${userId}>: they're back on Unranked.`;
}
