import assert from "node:assert/strict";
import { test } from "node:test";
import worker from "../src/index.js";
import { Discord } from "../src/discord.js";
import { renderLeaderboard } from "../src/leaderboard.js";
import { leaderboardRoles, link, rankOf, runRanks, unlink } from "../src/ranks.js";
import { Site } from "../src/site.js";
import { ENV, fakeD1, installFetch } from "./helpers.js";

// Role ids: Rookie 17, then tiers 11–16 lowest first, Unranked 10, titles 20–23, another role 99.
const ROLES = {
  RANK_ROLES: "Rookie=17, Apprentice=11, Master=12, Grandmaster=13, Ascendant=14, Champion=15, Sovereign=16",
  UNRANKED_ROLE_ID: "10",
  GOD_ROLE_IDS: "eu=20, na=21",
  DEMIGOD_ROLE_IDS: "eu=22, na=23",
  RANKUP_CHANNEL_ID: "rankups",
  RANK_REFRESH_MINUTES: "5",
  DISCORD_GUILD_ID: "guild1",
};
const env = (extra = {}) => ({ ...ENV, ...ROLES, DB: fakeD1(), ...extra });

const tier = (label) => ({ tier: label ? { label } : null });
/** A `/api/tiers` player: `regions` by region id, each a tier label or null. */
const rated = (playerId, name, regions) => ({ playerId, name, regions: Object.fromEntries(Object.entries(regions).map(([r, label]) => [r, tier(label)])) });
const member = (id, roles = ["10", "99"]) => ({ user: { id }, roles });

const roleCalls = (calls) => calls.filter((c) => c.path?.includes("/roles/")).map((c) => `${c.method} ${c.path.split("/").at(-3)} ${c.path.split("/").at(-1)}`);
const posts = (calls) => calls.filter((c) => c.method === "POST" && c.path === "/channels/rankups/messages");

async function check(e) {
  const discord = new Discord(e, 45);
  const site = new Site(e);
  await runRanks(e, discord, site, () => discord.left - site.calls);
}

test("a player's rank is their higher tier of EU and NA", () => {
  const e = env();
  assert.equal(rankOf(e, rated(1, "A", { eu: "Grandmaster", na: "Apprentice" })), "Grandmaster");
  assert.equal(rankOf(e, rated(1, "A", { eu: null, na: "Master" })), "Master");
  assert.equal(rankOf(e, rated(1, "A", { eu: null })), "");
  assert.equal(rankOf(e, rated(1, "A", {})), "");
  // Rookie is in `siteTier` only (the game has no Rookie tag, so `tier` is null).
  const rookie = { playerId: 1, name: "A", regions: { eu: { tier: null, siteTier: { label: "Rookie" } }, na: { tier: null, siteTier: null } } };
  assert.equal(rankOf(e, rookie), "Rookie");
});

test("/gr link gives the rank role at once; one player per member and one member per player", async () => {
  const e = env();
  const members = [member("100"), member("200")];
  const tiers = new Map([[7, rated(7, "Fealthy", { eu: "Grandmaster", na: "Apprentice" })]]);
  const calls = installFetch({ members, tiers });
  const discord = new Discord(e);
  const site = new Site(e);

  const reply = await link(e, discord, site, { userId: "100", has: ["10", "99"], playerId: 7 });
  assert.match(reply, /Linked <@100> to \*\*Fealthy\*\*.*Rank role: \*\*Grandmaster\*\*/);
  assert.deepEqual(roleCalls(calls), ["DELETE 100 10", "PUT 100 13"]);
  assert.deepEqual(members[0].roles.sort(), ["13", "99"]);

  assert.match(await link(e, discord, site, { userId: "200", has: ["10"], playerId: 7 }), /already linked to <@100>/);
  assert.match(await link(e, discord, site, { userId: "200", has: ["10"], playerId: 999 }), /isn't on genjiball\.us/);
  assert.match(await link(e, discord, site, { userId: "200", has: ["10"], playerId: null }), /couldn't find/);
});

test("the check follows climbs and drops, posts a climb once, fixes hand-set roles and touches no other role", async () => {
  const e = env();
  const members = [member("100"), member("200", ["15", "13", "99"]), member("300")];
  const tiers = new Map([
    [7, rated(7, "Fealthy", { eu: "Master" })],
    [8, rated(8, "Ipseity", { eu: "Champion" })],
    [9, rated(9, "New*Guy", {})],
  ]);
  const calls = installFetch({ members, tiers });
  const discord = new Discord(e);
  const site = new Site(e);
  for (const [userId, playerId] of [["100", 7], ["200", 8], ["300", 9]]) {
    await link(e, discord, site, { userId, has: members.find((m) => m.user.id === userId).roles, playerId });
  }
  // Linking set 200 straight: their extra Grandmaster role went.
  assert.deepEqual(members[1].roles.sort(), ["15", "99"]);
  calls.length = 0;

  // Fealthy climbs to Ascendant, Ipseity drops to Grandmaster; someone hands 300 the Champion role.
  tiers.set(7, rated(7, "Fealthy", { eu: "Ascendant" }));
  tiers.set(8, rated(8, "Ipseity", { eu: "Grandmaster" }));
  members[2].roles.push("15");
  await check(e);
  assert.deepEqual(roleCalls(calls).sort(), ["DELETE 100 12", "DELETE 200 15", "DELETE 300 15", "PUT 100 14", "PUT 200 13"]);
  assert.deepEqual(
    posts(calls).map((c) => [c.body.content, c.body.allowed_mentions]),
    [["**Fealthy** has ranked up to **Ascendant** 🏆", { parse: [] }]],
  );
  assert.deepEqual(members.map((m) => m.roles.sort()), [["14", "99"], ["13", "99"], ["10", "99"]]);

  // Nothing changed: no role calls, no second post.
  calls.length = 0;
  await check(e);
  assert.deepEqual(roleCalls(calls), []);
  assert.equal(posts(calls).length, 0);

  // A first rating is a climb from Unranked; the escaped name.
  tiers.set(9, rated(9, "New*Guy", { na: "Apprentice" }));
  await check(e);
  assert.equal(posts(calls).at(-1).body.content, "**New\\*Guy** has ranked up to **Apprentice** 🏆");
});

test("someone who left and rejoined gets their rank back on the next check", async () => {
  const e = env();
  const members = [member("100")];
  const tiers = new Map([[7, rated(7, "Fealthy", { eu: "Champion" })]]);
  const calls = installFetch({ members, tiers });
  await link(e, new Discord(e), new Site(e), { userId: "100", has: ["10"], playerId: 7 });
  members.length = 0;
  await check(e);
  assert.equal(roleCalls(calls).filter((c) => c.startsWith("PUT")).length, 1);
  members.push(member("100", ["10"]));
  await check(e);
  assert.deepEqual(members[0].roles.sort(), ["15"]);
  assert.equal(posts(calls).length, 0);
});

test("a check that runs out of budget carries on in the next minute", async () => {
  const e = env();
  const members = Array.from({ length: 6 }, (_, i) => member(String(100 + i), ["10"]));
  const tiers = new Map(members.map((m, i) => [i + 1, rated(i + 1, `P${i}`, { eu: "Master" })]));
  installFetch({ members, tiers });
  for (const [i, m] of members.entries()) {
    e.DB.raw.prepare("INSERT INTO links (user_id, player_id, name, rank, linked_at) VALUES (?, ?, ?, NULL, ?)").run(m.user.id, i + 1, `P${i}`, i);
  }
  // The members and the tiers, then room for three members' two changes (and one spare request).
  const discord = new Discord(e, 11);
  const site = new Site(e);
  await runRanks(e, discord, site, () => discord.left - site.calls);
  assert.equal(members.filter((m) => m.roles.includes("12")).length, 3);
  assert.ok(await e.DB.prepare("SELECT 1 FROM bot_state WHERE key = 'ranks_pending'").first());

  // Minute 5 isn't a check minute (4, 9, …), but the pending check goes on.
  await worker.scheduled({ scheduledTime: Date.UTC(2026, 9, 6, 10, 5) }, e);
  assert.equal(members.filter((m) => m.roles.includes("12")).length, 6);
  assert.equal(await e.DB.prepare("SELECT 1 FROM bot_state WHERE key = 'ranks_pending'").first(), null);
});

test("titles: linked members with a God or Demigod role, for the site's GET /titles", async () => {
  const e = env();
  const members = [member("100", ["15", "20"]), member("200", ["13", "22", "23"]), member("300", ["21"])];
  const tiers = new Map([
    [7, rated(7, "Fealthy", { eu: "Champion" })],
    [8, rated(4, "Ipseity", { eu: "Grandmaster", na: "Master" })], // 8 was merged into 4
  ]);
  installFetch({ members, tiers });
  for (const [userId, playerId] of [["100", 7], ["200", 8]]) {
    e.DB.raw.prepare("INSERT INTO links (user_id, player_id, name, rank, linked_at) VALUES (?, ?, '', NULL, 0)").run(userId, playerId);
  }
  await check(e);
  const res = await worker.fetch(new Request("https://bot.example/titles"), e, {});
  assert.deepEqual(await res.json(), {
    titles: [
      { playerId: 7, region: "eu", title: "God" },
      { playerId: 4, region: "eu", title: "Demigod" },
      { playerId: 4, region: "na", title: "Demigod" },
    ].sort((a, b) => a.region.localeCompare(b.region) || a.title.localeCompare(b.title) || a.playerId - b.playerId),
  });
  // The link follows the merge.
  assert.equal((await e.DB.prepare("SELECT player_id FROM links WHERE user_id = '200'").first()).player_id, 4);

  // A title role taken away is gone at the next check; unlinking takes the titles at once.
  tiers.set(4, rated(4, "Ipseity", { eu: "Grandmaster", na: "Master" }));
  members[1].roles = members[1].roles.filter((r) => r !== "23");
  await check(e);
  assert.equal((await (await worker.fetch(new Request("https://bot.example/titles"), e, {})).json()).titles.length, 2);
  assert.match(await unlink(e, new Discord(e), { userId: "100", has: members[0].roles }), /back on Unranked/);
  assert.deepEqual(members[0].roles.sort(), ["10", "20"]);
  assert.deepEqual((await (await worker.fetch(new Request("https://bot.example/titles"), e, {})).json()).titles.map((t) => t.playerId), [4]);
  assert.match(await unlink(e, new Discord(e), { userId: "100", has: [] }), /isn't linked/);
});

test("no RANK_ROLES: no checks, and /gr link says so", async () => {
  const e = env({ RANK_ROLES: "" });
  const calls = installFetch({ members: [member("100")] });
  await check(e);
  assert.equal(calls.length, 0);
  assert.match(await link(e, new Discord(e), new Site(e), { userId: "100", has: [], playerId: 7 }), /aren't set up/);
});

test("/gr leaderboard: ranks as their roles, God and Demigod in their place with the leaderboard's title roles", async () => {
  const e = env({ LEADERBOARD_TITLE_ROLES: "God=30, Demigod=31" });
  installFetch({
    titles: {
      eu: [
        { title: "God", rank: 3, id: 3, name: "Player3", rating: 1980 },
        { title: "Demigod", rank: 1, id: 1, name: "Fealthy", rating: 2000 },
      ],
    },
  });
  const { message } = await renderLeaderboard(new Site(e), "eu", 1, { roles: leaderboardRoles(e) });
  const lines = message.embeds[0].description.split("\n");
  assert.equal(lines.length, 20);
  assert.equal(lines[0], "` 1.` **Fealthy** — <@&31> · **2000 Elo**");
  assert.equal(lines[1], "` 2.` **Ipseity** — <@&13> · **1990 Elo**");
  assert.equal(lines[2], "` 3.` **Player3** — <@&30> · **1980 Elo**");
  assert.deepEqual(message.allowed_mentions, { parse: [] });

  // Page 2 goes on from 21; a tier without a role is written out.
  const two = await renderLeaderboard(new Site(e), "eu", 2, { roles: new Map([["Master", "12"]]) });
  assert.match(two.message.embeds[0].description.split("\n")[0], /^`21\.` \*\*Player21\*\* — Grandmaster ·/);
});

test("leaderboardRoles: the rank roles, Unranked's, and one role per title", () => {
  const roles = leaderboardRoles(env({ LEADERBOARD_TITLE_ROLES: "God=30, Demigod=31" }));
  assert.equal(roles.get("Rookie"), "17");
  assert.equal(roles.get("Sovereign"), "16");
  assert.equal(roles.get("God"), "30");
  assert.equal(roles.get("Demigod"), "31");
  assert.equal(roles.get("Unranked"), "10");
});

test("tiers are only read again when the match feed moved, a link is new, or an hour went by", async () => {
  const e = env();
  const members = [member("100")];
  const tiers = new Map([[7, rated(7, "Fealthy", { eu: "Master" })]]);
  const calls = installFetch({ members, tiers });
  const setCursor = (c) => e.DB.prepare("INSERT OR REPLACE INTO bot_state (key, value) VALUES ('match_feed_cursor', ?)").bind(c).run();
  const tierReads = () => calls.filter((c) => c.site && c.path.startsWith("/api/tiers")).length;
  const run = async (ms) => {
    const discord = new Discord(e, 45);
    const site = new Site(e);
    await runRanks(e, discord, site, () => discord.left - site.calls, ms);
  };
  await setCursor("10");
  await link(e, new Discord(e), new Site(e), { userId: "100", has: ["10"], playerId: 7 });
  const t0 = Date.UTC(2026, 9, 6, 10, 0);

  await run(t0);
  assert.equal(tierReads(), 2); // the link's, then the first full check
  // Nothing rated since: the members are still read, the tiers aren't.
  tiers.set(7, rated(7, "Fealthy", { eu: "Grandmaster" }));
  members[0].roles = ["99"]; // their rank role taken away by hand
  await run(t0 + 5 * 60_000);
  assert.equal(tierReads(), 2);
  assert.deepEqual(members[0].roles.sort(), ["12", "99"]);
  // A match was rated: the climb is seen.
  await setCursor("11");
  await run(t0 + 10 * 60_000);
  assert.equal(tierReads(), 3);
  assert.deepEqual(members[0].roles.sort(), ["13", "99"]);
  // An hour after the last read, even with no new match (a recompute isn't in the feed).
  await run(t0 + 30 * 60_000);
  assert.equal(tierReads(), 3);
  await run(t0 + 70 * 60_000);
  assert.equal(tierReads(), 4);
});

