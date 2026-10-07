import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { test } from "node:test";
import { commands } from "../scripts/commands.js";
import worker, { optionsOf } from "../src/index.js";
import { parseButton, renderLeaderboard } from "../src/leaderboard.js";
import { Site } from "../src/site.js";
import { listMessages } from "../src/tournament.js";
import { resultsPost } from "../src/results.js";
import { ENV, STAFF, fakeCtx, fakeD1, installFetch } from "./helpers.js";

// ---------- signed requests, as Discord sends them ----------

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const PUBLIC_KEY_HEX = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex");

function env(extra = {}) {
  return { ...ENV, DISCORD_PUBLIC_KEY: PUBLIC_KEY_HEX, DB: fakeD1(), ...extra };
}

async function send(e, interaction) {
  const body = JSON.stringify({ token: "itoken", channel_id: "chan1", guild_id: "guild1", ...interaction });
  const timestamp = "1700000000";
  const signature = sign(null, Buffer.from(timestamp + body), privateKey).toString("hex");
  const request = new Request("https://bot.example/interactions", {
    method: "POST",
    headers: { "X-Signature-Ed25519": signature, "X-Signature-Timestamp": timestamp },
    body,
  });
  const ctx = fakeCtx();
  const res = await worker.fetch(request, e, ctx);
  await ctx.done();
  return res.json();
}

const gr = (group, sub, options = []) => ({
  type: 2,
  member: STAFF,
  data: {
    name: "gr",
    options: sub ? [{ type: 2, name: group, options: [{ type: 1, name: sub, options }] }] : [{ type: 1, name: group, options }],
  },
});
const opt = (name, value) => ({ type: 3, name, value });

const player = (id, nick = `Player ${id}`) => ({ user: { id, username: nick.toLowerCase() }, nick, roles: [], permissions: "0" });
const press = (customId, member) => ({ type: 3, member, data: { custom_id: customId, component_type: 2 } });
const dmPress = (customId, id) => ({ type: 3, user: { id, username: id }, guild_id: undefined, data: { custom_id: customId, component_type: 2 } });

/** What the bot posted to Discord, by call. */
const posts = (calls, channel) => calls.filter((c) => c.method === "POST" && c.path === `/channels/${channel}/messages`);
const lastOriginal = (calls) => calls.filter((c) => c.method === "PATCH" && c.path.endsWith("/@original")).at(-1)?.body;

async function cron(e, ms) {
  await worker.scheduled({ scheduledTime: ms }, e);
}

// Tue 6 Oct 2026 10:00 UTC. The tourney starts Saturday 10 Oct, 19:00 UTC (21:00 CEST).
const NOW = Date.UTC(2026, 9, 6, 10, 0);
const START = Date.UTC(2026, 9, 10, 19, 0);

/** A tourney an admin made on the site. */
function siteTourney(siteTourneys, fields = {}) {
  const t = { id: 41 + siteTourneys.size, name: "EU FFA Tournament", region: "eu", startsAt: new Date(START).toISOString(), status: "scheduled", lobbies: [], ...fields };
  siteTourneys.set(t.id, t);
  return t;
}

// ---------- commands ----------

test("every command is under /gr, and there's no /gr host", () => {
  assert.deepEqual(commands.map((c) => c.name), ["gr"]);
  assert.deepEqual(commands[0].options.map((o) => o.name), ["stats", "leaderboard", "setup"]);
});

test("reads /gr setup leaderboard's path and options", () => {
  const { path, options } = optionsOf(gr("setup", "leaderboard", [{ type: 7, name: "channel", value: "c9" }]).data);
  assert.deepEqual(path, ["setup", "leaderboard"]);
  assert.deepEqual(options, { channel: "c9" });
});

test("staff commands are staff only; everyone can use /gr stats", async () => {
  const e = env();
  const calls = installFetch();
  const denied = await send(e, { ...gr("leaderboard", null, [opt("region", "eu")]), member: player("p1") });
  assert.equal(denied.type, 4);
  assert.match(denied.data.content, /Only \*\*Staff\*\*/);

  const stats = await send(e, { ...gr("stats", null, [opt("player", "Fealthy")]), member: player("p1") });
  assert.equal(stats.type, 5);
  assert.match(lastOriginal(calls).embeds[0].title, /Fealthy — EU/);

  const admin = { user: { id: "owner" }, roles: [], permissions: String(1n << 3n) };
  assert.equal((await send(e, { ...gr("leaderboard", null, []), member: admin })).type, 5);
});

// ---------- the whole tournament ----------

test("a tourney made on the site, from its sign-up post to the final list", async () => {
  const e = env();
  const siteTourneys = new Map();
  const calls = installFetch({ siteTourneys, closedDms: new Set(["p3"]) });
  const { id } = siteTourney(siteTourneys);

  // The bot never changes the site.
  const siteWrites = () => calls.filter((c) => c.site && c.method !== "GET");

  // The sync (every 5 minutes) posts it once, in the sign-ups channel, with no pings.
  await cron(e, NOW + 60_000); // minute 1: no sync
  assert.equal(posts(calls, "signups").length, 0);
  await cron(e, NOW + 5 * 60_000);
  await cron(e, NOW + 10 * 60_000);
  const [post, ...more] = posts(calls, "signups");
  assert.equal(more.length, 0);
  assert.equal(post.body.content, "");
  assert.deepEqual(post.body.allowed_mentions, { parse: [] });
  assert.equal(post.body.embeds[0].title, "🏆 EU FFA Tournament");
  assert.match(post.body.embeds[0].description, /<t:1791658800:F>/);
  assert.deepEqual(post.body.components[0].components.map((b) => b.label), ["Register", "Unregister", "Who's signed up"]);
  assert.equal(post.body.components[0].components[0].style, 3); // green

  // Four players register; one leaves again.
  for (const p of ["p1", "p2", "p3", "p4"]) {
    const r = await send(e, press(`gr:reg:${id}`, player(p)));
    assert.equal(r.data.flags, 64);
    assert.match(r.data.content, /You're registered/);
  }
  assert.match((await send(e, press(`gr:reg:${id}`, player("p1")))).data.content, /already registered/);
  assert.match((await send(e, press(`gr:unreg:${id}`, player("p4")))).data.content, /no longer registered/);
  const who = await send(e, press(`gr:who:${id}`, player("p9")));
  assert.match(who.data.content, /\*\*3 signed up\*\*\n1\. Player p1\n2\. Player p2\n3\. Player p3/);
  const edits = calls.filter((c) => c.method === "PATCH" && c.path.startsWith("/channels/signups/messages/"));
  assert.match(JSON.stringify(edits.at(-1).body.embeds[0].fields), /\*\*3\*\*/);

  // An admin renames it on the site: the post follows on the next sync.
  siteTourneys.get(id).name = "EU Halloween Cup";
  await cron(e, NOW + 15 * 60_000);
  assert.match(calls.filter((c) => c.method === "PATCH").at(-1).body.embeds[0].title, /EU Halloween Cup/);

  // 6 minutes before: nothing yet. 5 minutes before: Confirm DMs. p3 has DMs closed.
  await cron(e, START - 6 * 60_000);
  assert.equal(calls.filter((c) => c.path?.startsWith("/channels/dm-")).length, 0);
  await cron(e, START - 5 * 60_000);
  const dms = calls.filter((c) => c.method === "POST" && c.path?.startsWith("/channels/dm-"));
  assert.deepEqual(dms.map((c) => c.path), ["/channels/dm-p1/messages", "/channels/dm-p2/messages", "/channels/dm-p3/messages"]);
  assert.match(dms[0].body.content, /^⏰ \*\*Tournament starting in 5 minutes\*\*/);
  assert.deepEqual(dms[0].body.components[0].components.map((b) => [b.label, b.custom_id]), [["Confirm", `gr:conf:${id}`]]);
  assert.match(JSON.stringify(calls.filter((c) => c.method === "PATCH").at(-1).body), /confirming now/);

  // Nobody gets a second DM on the next run.
  await cron(e, START - 4 * 60_000);
  assert.equal(calls.filter((c) => c.method === "POST" && c.path?.startsWith("/channels/dm-")).length, 3);

  // p1 confirms; p2 doesn't. p5 registers late and is confirmed at once.
  const confirmed = await send(e, dmPress(`gr:conf:${id}`, "p1"));
  assert.equal(confirmed.type, 7);
  assert.match(confirmed.data.content, /Confirmed/);
  assert.deepEqual(confirmed.data.components, []);
  assert.match((await send(e, press(`gr:reg:${id}`, player("p5")))).data.content, /registered and confirmed/);
  assert.match((await send(e, press(`gr:who:${id}`, player("p9")))).data.content, /4 signed up · 2 confirmed/);

  // The start: the post is deleted and the list posted.
  await cron(e, START);
  assert.ok(calls.some((c) => c.method === "DELETE" && c.path.startsWith("/channels/signups/messages/")));
  const list = posts(calls, "signups").at(-1).body;
  assert.equal(list.content, "📋 **EU Halloween Cup** · **2 confirmed players**\n1. <@p1>\n2. <@p5>\n\nHosts: split the lobbies from this list.");
  assert.deepEqual(list.allowed_mentions, { parse: [] });

  // Too late to confirm or register now, and the sync doesn't post it again.
  assert.match((await send(e, dmPress(`gr:conf:${id}`, "p2"))).data.content, /Too late/);
  assert.match((await send(e, press(`gr:reg:${id}`, player("p6")))).data.content, /closed/);
  const before = posts(calls, "signups").length;
  await cron(e, START + 5 * 60_000);
  assert.equal(posts(calls, "signups").length, before);

  // Standings, once an admin marks it done on the site (checked every 10 minutes).
  Object.assign(siteTourneys.get(id), {
    status: "done",
    lobbies: [{ label: "Lobby 1", verified: true, standings: [{ place: 1, name: "Fealthy", wins: 12, kills: 40 }] }],
  });
  await cron(e, START + 60 * 60_000);
  assert.match(posts(calls, "signups").at(-1).body.embeds[0].title, /standings/);
  await cron(e, START + 70 * 60_000);
  assert.equal(posts(calls, "signups").filter((p) => p.body.embeds?.[0]?.title?.includes("standings")).length, 1);
  assert.deepEqual(siteWrites(), []);
});

test("cancelled on the site: the post is crossed out, no DMs or list", async () => {
  const e = env();
  const siteTourneys = new Map();
  const calls = installFetch({ siteTourneys });
  const t = siteTourney(siteTourneys);
  await cron(e, NOW);
  await send(e, press(`gr:reg:${t.id}`, player("p1")));
  t.status = "cancelled";
  await cron(e, NOW + 5 * 60_000);
  const edit = calls.filter((c) => c.method === "PATCH" && c.path.startsWith("/channels/signups/")).at(-1).body;
  assert.match(edit.embeds[0].title, /Cancelled/);
  assert.deepEqual(edit.components, []);
  assert.match((await send(e, press(`gr:reg:${t.id}`, player("p2")))).data.content, /cancelled/);
  await cron(e, START - 5 * 60_000);
  await cron(e, START);
  assert.equal(calls.filter((c) => c.path?.startsWith("/channels/dm-")).length, 0);
  assert.equal(posts(calls, "signups").length, 1);
});

test("moved later on the site while confirming: back to sign-ups, DMs again at the new time", async () => {
  const e = env();
  const siteTourneys = new Map();
  const calls = installFetch({ siteTourneys });
  const t = siteTourney(siteTourneys);
  await cron(e, NOW);
  await send(e, press(`gr:reg:${t.id}`, player("p1")));
  await cron(e, START - 5 * 60_000);
  const dmCount = () => calls.filter((c) => c.method === "POST" && c.path?.startsWith("/channels/dm-")).length;
  assert.equal(dmCount(), 1);

  const later = START + 60 * 60_000;
  t.startsAt = new Date(later).toISOString();
  await cron(e, START - 5 * 60_000 + 5 * 60_000); // the next sync, at the old start: no list
  assert.equal(calls.some((c) => c.method === "DELETE"), false);
  assert.match(calls.filter((c) => c.method === "PATCH").at(-1).body.embeds[0].description, new RegExp(`<t:${later / 1000}:F>`));
  await cron(e, later - 5 * 60_000);
  assert.equal(dmCount(), 2);
});

test("a site error never cancels a tourney, and past ones aren't posted", async () => {
  const e = env();
  const siteTourneys = new Map();
  let calls = installFetch({ siteTourneys });
  siteTourney(siteTourneys, { startsAt: new Date(NOW - 60_000).toISOString() });
  const t = siteTourney(siteTourneys);
  await cron(e, NOW);
  assert.equal(posts(calls, "signups").length, 1);
  calls = installFetch({ siteTourneys, siteDown: true });
  await cron(e, NOW + 5 * 60_000);
  await send(e, press(`gr:reg:${t.id}`, player("p1")));
  installFetch({ siteTourneys });
  assert.ok((await e.DB.prepare("SELECT phase FROM tournaments WHERE id = ?").bind(t.id).first()).phase === "open");
});

test("no tourney channel set: nothing is posted", async () => {
  const e = env({ TOURNEY_CHANNEL_ID: "" });
  const siteTourneys = new Map();
  const calls = installFetch({ siteTourneys });
  siteTourney(siteTourneys);
  await cron(e, NOW);
  assert.equal(calls.filter((c) => c.site && c.path.startsWith("/api/tourneys")).length, 0);
});

test("a long list is split under 2,000 characters", () => {
  const ids = Array.from({ length: 120 }, (_, i) => `1234567890123456${String(i).padStart(3, "0")}`);
  const messages = listMessages({ name: "EU FFA Tournament" }, ids);
  assert.ok(messages.length > 1);
  assert.ok(messages.every((m) => m.length <= 2000));
  assert.equal(messages.join("\n").match(/<@/g).length, 120);
  assert.match(messages.at(-1), /Hosts: split the lobbies/);
  assert.deepEqual(listMessages({ name: "X" }, []), ["📋 **X** · **0 confirmed players**\nNobody confirmed, so this tournament has no players."]);
});

// ---------- tournament results ----------

const RESULT_PLAYERS = [
  { id: 2, name: "MauMau", roundWins: 7, kills: 31, place: 2, ratingBefore: 1962, ratingAfter: 2004 },
  { id: 1, name: "DrunkenWiz", roundWins: 11, kills: 38, place: 1, ratingBefore: 2043, ratingAfter: 2131 },
  { id: 3, name: "Anubis", roundWins: 1, kills: 12, place: 3, ratingBefore: 1736, ratingAfter: 1689 },
  { id: 4, name: "New_Guy", roundWins: 0, kills: 2, place: 4, ratingBefore: null, ratingAfter: 1012 },
];
const wins = (n) => Array.from({ length: n }, () => ({ result: "WIN" }));
const tourneyMatch = (fields = {}) => ({
  id: 900,
  region: "eu",
  playedAt: "2026-10-10T19:40:00Z",
  void: false,
  tournament: true,
  tourney: { id: 41, name: "EU FFA Tournament", lobby: "Lobby 1" },
  players: RESULT_PLAYERS,
  rounds: [...wins(19), { result: "NONE" }],
  ...fields,
});
// The feed's own copy of a match: players with ratings, no stats.
const feedCopy = (m) => ({ ...m, players: m.players.map(({ id, name, ratingBefore, ratingAfter }) => ({ id, name, ratingBefore, ratingAfter })) });
const RESULTS_MINUTE = Date.UTC(2026, 9, 10, 20, 2); // a :x2 minute, when results are checked

test("the results post: ranked by place, wins, kills and the rating change, no emojis or pings", () => {
  const message = resultsPost(new Site(ENV), tourneyMatch());
  const embed = message.embeds[0];
  assert.equal(embed.title, "EU FFA Tournament · Lobby 1");
  assert.equal(embed.url, "https://genjiball.us/match?id=900");
  assert.equal(embed.color, 0xed4245);
  assert.equal(
    embed.description,
    "EU · 19 rounds · <t:1791661200:D>\n\n" +
      "`1.` **DrunkenWiz** — 11 wins · 38 kills · 2043 → **2131** **+88**\n" +
      "`2.` **MauMau** — 7 wins · 31 kills · 1962 → **2004** **+42**\n" +
      "`3.` **Anubis** — 1 win · 12 kills · 1736 → **1689** **−47**\n" +
      "`4.` **New\\_Guy** — 0 wins · 2 kills · new → **1012**",
  );
  assert.deepEqual(message.allowed_mentions, { parse: [] });
  assert.doesNotMatch(JSON.stringify(message), /[\u{1F300}-\u{1FAFF}]/u);
});

test("results follow the match feed: posted once rated, edited on a change, deleted when voided", async () => {
  const e = env();
  const feed = { entries: [], details: new Map() };
  const calls = installFetch({ feed });
  const old = tourneyMatch({ id: 800 });
  feed.entries.push({ seq: 1, match: feedCopy(old) });
  feed.details.set(800, old);

  // The first run only takes the cursor: matches from before the bot are never posted.
  await cron(e, RESULTS_MINUTE);
  assert.equal(posts(calls, "results").length, 0);

  // A ranked (not tournament) match and an unrated tournament match: nothing.
  const ranked = tourneyMatch({ id: 901, tournament: false, tourney: null });
  const unrated = tourneyMatch({ players: RESULT_PLAYERS.map((p) => ({ ...p, ratingBefore: null, ratingAfter: null })) });
  feed.entries.push({ seq: 2, match: feedCopy(ranked) }, { seq: 3, match: feedCopy(unrated) });
  feed.details.set(901, ranked);
  feed.details.set(900, unrated);
  await cron(e, RESULTS_MINUTE + 5 * 60_000);
  assert.equal(posts(calls, "results").length, 0);

  // Rated: the feed lists it again, and it's posted.
  const rated = tourneyMatch();
  feed.details.set(900, rated);
  feed.entries.push({ seq: 4, match: feedCopy(rated) });
  await cron(e, RESULTS_MINUTE + 10 * 60_000);
  const [post] = posts(calls, "results");
  assert.match(post.body.embeds[0].description, /DrunkenWiz\*\* — 11 wins · 38 kills · 2043 → \*\*2131\*\* \*\*\+88\*\*/);

  // Listed again with nothing new: no second post, no edit.
  feed.entries.push({ seq: 5, match: feedCopy(rated) });
  await cron(e, RESULTS_MINUTE + 15 * 60_000);
  assert.equal(posts(calls, "results").length, 1);
  assert.equal(calls.filter((c) => c.method === "PATCH" && c.path.startsWith("/channels/results/")).length, 0);

  // A longer copy changes the numbers: the post is edited.
  const longer = tourneyMatch({ players: RESULT_PLAYERS.map((p) => (p.id === 1 ? { ...p, roundWins: 12, ratingAfter: 2140 } : p)) });
  feed.details.set(900, longer);
  feed.entries.push({ seq: 6, match: feedCopy(longer) });
  await cron(e, RESULTS_MINUTE + 20 * 60_000);
  const edit = calls.filter((c) => c.method === "PATCH" && c.path.startsWith("/channels/results/")).at(-1);
  assert.match(edit.body.embeds[0].description, /12 wins · 38 kills · 2043 → \*\*2140\*\* \*\*\+97\*\*/);

  // Voided: the post is deleted.
  feed.entries.push({ seq: 7, match: { ...feedCopy(longer), void: true } });
  await cron(e, RESULTS_MINUTE + 25 * 60_000);
  assert.ok(calls.some((c) => c.method === "DELETE" && c.path.startsWith("/channels/results/messages/")));
  assert.equal(posts(calls, "results").length, 1);
});

test("a busy feed is read a page at a time and nothing is skipped", async () => {
  const e = env();
  const feed = { entries: [], details: new Map() };
  const calls = installFetch({ feed });
  await cron(e, RESULTS_MINUTE);
  for (let i = 0; i < 12; i++) {
    const m = tourneyMatch({ id: 1000 + i });
    feed.details.set(m.id, m);
    feed.entries.push({ seq: 10 + i, match: feedCopy(m) });
  }
  await cron(e, RESULTS_MINUTE + 5 * 60_000);
  await cron(e, RESULTS_MINUTE + 10 * 60_000);
  assert.deepEqual(
    posts(calls, "results").map((p) => p.body.embeds[0].url.split("=")[1]),
    Array.from({ length: 12 }, (_, i) => String(1000 + i)),
  );
});

// ---------- leaderboard ----------

test("leaderboard: EU default, NA tab, pages up to 5", async () => {
  installFetch();
  const { message } = await renderLeaderboard(new Site(ENV), undefined, undefined);
  assert.match(message.embeds[0].title, /EU Leaderboard — Top 15/);
  assert.match(message.embeds[0].description, /\*\*Fealthy\*\* — Grandmaster · \*\*2000 Elo\*\*/);
  assert.deepEqual(parseButton("lb:n:na:2"), { region: "na", page: 2 });
  const five = await renderLeaderboard(new Site(ENV), "na", 9);
  assert.match(five.message.embeds[0].title, /NA Leaderboard — Top 75/);
  assert.equal(five.message.components[1].components[2].disabled, true);
});

test("unsigned requests are refused", async () => {
  const res = await worker.fetch(new Request("https://bot.example/interactions", { method: "POST", body: "{}" }), env(), fakeCtx());
  assert.equal(res.status, 401);
});
