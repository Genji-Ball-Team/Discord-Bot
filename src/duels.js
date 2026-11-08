// Duels: the 1v1s staff enter on genjiball.us (genjiball-ranked docs/api.md, "Duels"), posted in
// DUELS_CHANNEL_ID as plain lines, one a duel: "⚔️ EU · **A** beat **B** 15–8 · **+11** / **−11**".
//
// Duels aren't in the match feed, so the cron reads each region's newest page (`/api/duels`, newest
// first) and posts the ones newer than the last it saw, oldest first, in one message: an admin saves
// a night's duels together, so they land together. A duel the page no longer lists while newer ones
// are still there was voided (undone): its line is taken out of its message, and the message deleted
// when it has none left.

import { NO_PINGS, lostAccess } from "./discord.js";
import { REGIONS, escapeMarkdown, regionInfo } from "./site.js";
import { setting } from "./time.js";
import { getState } from "./results.js";

/** Discord's limit for a message's text. */
const MESSAGE_MAX = 2000;

function signed(n) {
  if (n > 0) return `+${n}`;
  if (n < 0) return `−${-n}`;
  return "±0";
}

/** The rating change of one side, or null for a duel that changed no rating. */
function change(side) {
  if (side?.ratingBefore === null || side?.ratingBefore === undefined) return null;
  if (side.ratingAfter === null || side.ratingAfter === undefined) return null;
  return Math.round(side.ratingAfter) - Math.round(side.ratingBefore);
}

/**
 * How long a rated duel whose ratings the site hasn't written yet is held back. The site rates
 * duels as they're saved, and its cron catches any it missed within about 10 minutes; past this, the
 * line is posted as it is.
 */
const PENDING_WAIT_MS = 30 * 60 * 1000;

/** A rated duel the site hasn't put ratings on yet (still being rated), and not too old to wait for. */
function pending(duel, now) {
  if (duel.rated === false) return false;
  const rated = (side) => side?.ratingAfter !== null && side?.ratingAfter !== undefined;
  if (rated(duel.winner) && rated(duel.loser)) return false;
  return now - Date.parse(duel.playedAt) < PENDING_WAIT_MS;
}

/** One duel's line, from `/api/duels`. */
export function duelLine(region, duel) {
  const won = change(duel.winner);
  const lost = change(duel.loser);
  const rating = duel.rated === false || won === null || lost === null ? "not rated" : `**${signed(won)}** / **${signed(lost)}**`;
  return `⚔️ ${regionInfo(region).label} · **${escapeMarkdown(duel.winner.name)}** beat **${escapeMarkdown(duel.loser.name)}** ${duel.winnerScore}–${duel.loserScore} · ${rating}`;
}

/** Lines into as few messages as fit Discord's limit. */
function chunks(lines) {
  const out = [];
  for (const line of lines) {
    const last = out.at(-1);
    if (last && last.join("\n").length + 1 + line.length <= MESSAGE_MAX) last.push(line);
    else out.push([line]);
  }
  return out;
}

const message = (lines) => ({ content: lines.join("\n"), allowed_mentions: NO_PINGS });

const setState = (env, key, value) => env.DB.prepare("INSERT OR REPLACE INTO bot_state (key, value) VALUES (?, ?)").bind(key, String(value)).run();

/** Takes voided duels' lines out of their messages; a message left empty is deleted. */
async function removeVoided(env, discord, voided) {
  const messages = new Set(voided.map((p) => p.message_id));
  for (const post of voided) await env.DB.prepare("DELETE FROM duel_posts WHERE duel_id = ?").bind(post.duel_id).run();
  for (const messageId of messages) {
    const channelId = voided.find((p) => p.message_id === messageId).channel_id;
    const { results: left } = await env.DB.prepare("SELECT line FROM duel_posts WHERE message_id = ? ORDER BY duel_id").bind(messageId).all();
    const done = left.length ? discord.editMessage(channelId, messageId, message(left.map((p) => p.line))) : discord.deleteMessage(channelId, messageId);
    // Someone deleted it already: nothing to do.
    await done.catch((e) => {
      if (!lostAccess(e)) throw e;
    });
  }
}

/** One region: post its new duels and take out the voided ones. */
async function regionDuels(env, discord, site, channelId, region, now) {
  const data = await site.duels(region);
  if (!data) return;
  const duels = data.duels ?? [];
  const key = `duel_cursor_${region}`;
  const cursor = await getState(env, key);
  const newest = duels.reduce((max, d) => Math.max(max, d.id), Number(cursor ?? 0));
  // The first run only notes where the duels are, so old ones aren't posted.
  if (cursor === null) {
    await setState(env, key, newest);
    return;
  }

  // Voided: posted, in the range this page covers, and no longer listed.
  const listed = new Set(duels.map((d) => d.id));
  const oldest = data.hasMore ? Math.min(...duels.map((d) => d.id)) : 0;
  const { results: posted } = await env.DB.prepare("SELECT * FROM duel_posts WHERE region = ? AND duel_id >= ?").bind(region, oldest).all();
  const voided = posted.filter((p) => !listed.has(p.duel_id) && p.duel_id <= Number(cursor));
  if (voided.length) await removeVoided(env, discord, voided);
  // Older than the page: they can't be checked any more, so they're let go.
  if (data.hasMore) await env.DB.prepare("DELETE FROM duel_posts WHERE region = ? AND duel_id < ?").bind(region, oldest).run();

  const fresh = duels.filter((d) => d.id > Number(cursor)).sort((a, b) => a.id - b.id);
  // A duel still being rated waits, and so do the ones after it, so lines go out in order.
  const wait = fresh.findIndex((d) => pending(d, now));
  if (wait >= 0) fresh.splice(wait);
  for (const group of chunks(fresh.map((d) => duelLine(region, d)))) {
    const sent = await discord.sendMessage(channelId, message(group)).catch((e) => {
      if (!lostAccess(e)) throw e;
      console.error(`duels: can't post in ${channelId}`);
      return null;
    });
    if (!sent) break;
    const ids = fresh.splice(0, group.length).map((d) => d.id);
    await env.DB.batch(
      ids.map((id, i) => env.DB.prepare("INSERT OR REPLACE INTO duel_posts (duel_id, region, channel_id, message_id, line) VALUES (?, ?, ?, ?, ?)").bind(id, region, channelId, sent.id, group[i])),
    );
    await setState(env, key, ids.at(-1));
  }
  // Nothing was left to post (or none could be): move on past what was listed, unless one waits.
  if (!fresh.length && wait < 0) await setState(env, key, newest);
}

/** On the cron: each region's new duels, while the run's request budget lasts. */
export async function postDuels(env, discord, site, budget, now = Date.now()) {
  const channelId = setting(env, "DUELS_CHANNEL_ID");
  if (!channelId) return;
  for (const region of Object.keys(REGIONS)) {
    // A site read, a few posts and edits.
    if (budget() < 6) return;
    await regionDuels(env, discord, site, channelId, region, now);
  }
}
