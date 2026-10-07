// Tournament results: every tournament match the site rates is posted in RESULTS_CHANNEL_ID,
// players ranked as in the tourney standings (most wins, ties broken by kills) with their wins,
// kills and rating change.
//
// The bot follows the site's match feed (`/api/matches?after=<cursor>`, genjiball-ranked
// docs/api.md), which lists a match again whenever a post would show something new: once it's
// rated, voided, a longer copy, linked to a tourney. A post is made once the match is rated, edited
// when what it shows changes, and deleted when the match is voided or stops being a tournament.
// A later recompute that moves ratings isn't in the feed, so a post keeps the numbers it was made with.

import { NO_PINGS, lostAccess } from "./discord.js";
import { REGIONS, escapeMarkdown } from "./site.js";
import { discordTime } from "./time.js";

const resultsChannel = (env) => (env.RESULTS_CHANNEL_ID ?? "").trim();
/** Matches per feed page: each may cost a site request and a Discord one. */
const FEED_PAGE = 5;

function signed(n) {
  if (n > 0) return `+${n}`;
  if (n < 0) return `−${-n}`;
  return "±0";
}

function ratingText(p) {
  if (p.ratingAfter === null || p.ratingAfter === undefined) return "not rated";
  const after = Math.round(p.ratingAfter);
  if (p.ratingBefore === null || p.ratingBefore === undefined) return `new → **${after}**`;
  const before = Math.round(p.ratingBefore);
  return `${before} → **${after}** **${signed(after - before)}**`;
}

/** The post for a rated tournament match, from `/api/matches/:id`. */
export function resultsPost(site, match) {
  const info = REGIONS[match.region] ?? REGIONS.eu;
  const players = [...(match.players ?? [])].sort(
    (a, b) => (a.place ?? 99) - (b.place ?? 99) || (b.roundWins ?? 0) - (a.roundWins ?? 0) || (b.kills ?? 0) - (a.kills ?? 0),
  );
  const lines = players.map((p) => {
    const wins = p.roundWins ?? p.wins ?? 0;
    const kills = p.kills ?? 0;
    return `\`${p.place ?? "–"}.\` **${escapeMarkdown(p.name)}** — ${wins} ${wins === 1 ? "win" : "wins"} · ${kills} ${kills === 1 ? "kill" : "kills"} · ${ratingText(p)}`;
  });
  const rounds = (match.rounds ?? []).filter((r) => r.result === "WIN").length;
  const title = match.tourney ? `${match.tourney.name} · ${match.tourney.lobby}` : "Tournament match";
  return {
    embeds: [
      {
        title: title.slice(0, 256),
        url: `${site.base}/match?id=${match.id}`,
        description: [`${info.label} · ${rounds} rounds · ${discordTime(Date.parse(match.playedAt), "D")}`, "", ...lines].join("\n").slice(0, 4096),
        color: 0xed4245,
        footer: { text: `Tournament match: counts 3×, nobody moves more than ±200 · Match #${match.id} on genjiball.us` },
      },
    ],
    allowed_mentions: NO_PINGS,
  };
}

const isRated = (m) => (m.players ?? []).some((p) => p.ratingAfter !== null && p.ratingAfter !== undefined);

async function getState(env, key) {
  return (await env.DB.prepare("SELECT value FROM bot_state WHERE key = ?").bind(key).first())?.value ?? null;
}

function setState(env, key, value) {
  return env.DB.prepare("INSERT OR REPLACE INTO bot_state (key, value) VALUES (?, ?)").bind(key, String(value));
}

async function removePost(env, discord, post) {
  await discord.deleteMessage(post.channel_id, post.message_id).catch((e) => {
    if (!lostAccess(e)) throw e;
  });
  await env.DB.prepare("DELETE FROM result_posts WHERE match_id = ?").bind(post.match_id).run();
}

/** One match from the feed: post, edit or delete its results. */
async function handleMatch(env, discord, site, channelId, item) {
  const post = await env.DB.prepare("SELECT * FROM result_posts WHERE match_id = ?").bind(item.id).first();
  const gone = item.removed || item.void || !item.tournament;
  if (gone) {
    if (post) await removePost(env, discord, post);
    return;
  }
  if (!isRated(item)) return; // listed again once it's rated
  const data = await site.get(`/api/matches/${item.id}`);
  const match = data?.match;
  if (!match || match.void || !match.tournament) {
    if (post) await removePost(env, discord, post);
    return;
  }
  const message = resultsPost(site, match);
  const shown = JSON.stringify(message);
  if (post?.shown === shown) return;
  if (post) {
    try {
      await discord.editMessage(post.channel_id, post.message_id, message);
      await env.DB.prepare("UPDATE result_posts SET shown = ? WHERE match_id = ?").bind(shown, item.id).run();
      return;
    } catch (e) {
      if (!lostAccess(e)) throw e;
      // Someone deleted the post: leave it deleted.
      return;
    }
  }
  const sent = await discord.sendMessage(channelId, message).catch((e) => {
    if (!lostAccess(e)) throw e;
    console.error(`can't post results in ${channelId}`, e);
    return null;
  });
  if (!sent) return;
  await env.DB.prepare("INSERT OR REPLACE INTO result_posts (match_id, channel_id, message_id, shown) VALUES (?, ?, ?, ?)")
    .bind(item.id, channelId, sent.id, shown)
    .run();
}

/**
 * Follows the match feed from where it left off. The first run only takes the current cursor, so
 * old matches aren't posted. A page is only started when the budget covers all of it, so the cursor
 * never moves past a match that wasn't handled.
 */
export async function postResults(env, discord, site, budget) {
  const channelId = resultsChannel(env);
  if (!channelId) return;
  let cursor = await getState(env, "match_feed_cursor");
  if (cursor === null) {
    const start = await site.get("/api/matches", { after: "latest" });
    if (start?.cursor !== undefined) await setState(env, "match_feed_cursor", start.cursor).run();
    return;
  }
  for (let page = 0; page < 4; page++) {
    if (budget() < FEED_PAGE * 2 + 3) return;
    const data = await site.get("/api/matches", { after: cursor, limit: FEED_PAGE });
    if (!data) return;
    for (const item of data.matches ?? []) await handleMatch(env, discord, site, channelId, item);
    cursor = data.cursor;
    await setState(env, "match_feed_cursor", cursor).run();
    if (!data.hasMore) return;
  }
}
