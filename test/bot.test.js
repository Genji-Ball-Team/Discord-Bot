import assert from "node:assert/strict";
import { test } from "node:test";
import worker, { optionsOf } from "../src/index.js";
import { fetchRanks, formatLines, parseButton, renderLeaderboard } from "../src/leaderboard.js";
import { Site } from "../src/site.js";
import { Discord } from "../src/discord.js";
import { sendReminders, syncTourneys } from "../src/tourneys.js";
import { ENV, STAFF, fakeCtx, fakeD1, fakeTourney, installFetch } from "./helpers.js";

// ---------- leaderboard ----------

test("page 4 (ranks 46–60) reads API pages 1 and 2", async () => {
  const calls = installFetch();
  const { players, more } = await fetchRanks(new Site(ENV), "eu", 46, 60);
  assert.deepEqual(players.map((p) => p.rank), [46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60]);
  assert.equal(more, true);
  assert.equal(calls.filter((c) => c.site).length, 2);
});

test("lines look like '` 1.` **Fealthy** — Grandmaster · **2000 Elo**'", () => {
  const lines = formatLines([
    { rank: 1, name: "Fealthy", rating: 2000.4, tier: { label: "Grandmaster" } },
    { rank: 10, name: "Ipse_ity", rating: 1600, tier: null },
  ]);
  assert.deepEqual(lines, ["` 1.` **Fealthy** — Grandmaster · **2000 Elo**", "`10.` **Ipse\\_ity** — Unranked · **1600 Elo**"]);
});

test("buttons: EU default, NA switch, pages up to 5, ids unique", async () => {
  installFetch();
  const { message } = await renderLeaderboard(new Site(ENV), undefined, undefined);
  const [regionRow, pageRow] = message.components;
  assert.match(message.embeds[0].title, /EU Leaderboard — Top 15/);
  assert.match(message.embeds[0].description, /^` 1\.` \*\*Fealthy\*\*/);
  assert.equal(regionRow.components[0].disabled, true); // EU is current
  assert.equal(pageRow.components[0].disabled, true); // no Prev on page 1
  const ids = [...regionRow.components, ...pageRow.components].map((b) => b.custom_id);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(parseButton(regionRow.components[1].custom_id), { region: "na", page: 1 });
  assert.deepEqual(parseButton(pageRow.components[2].custom_id), { region: "eu", page: 2 });

  const last = await renderLeaderboard(new Site(ENV), "na", 5);
  assert.match(last.message.embeds[0].title, /NA Leaderboard — Top 75/);
  assert.match(last.message.embeds[0].description, /^`61\.`/);
  assert.equal(last.message.components[1].components[2].disabled, true); // no page 6
});

test("Next is off when fewer players than the next page", async () => {
  installFetch({ boardTotal: 20 });
  const { message } = await renderLeaderboard(new Site(ENV), "eu", 2);
  assert.equal(message.components[1].components[2].disabled, true);
  assert.equal(message.embeds[0].description.split("\n").length, 5); // ranks 16–20
});

// ---------- the worker: signatures, commands, buttons ----------

async function keys() {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  return { pair, publicKey: Buffer.from(raw).toString("hex") };
}

async function signed(k, payload, tamper = false) {
  const body = JSON.stringify(payload);
  const timestamp = "1759744800";
  const sig = new Uint8Array(await crypto.subtle.sign("Ed25519", k.pair.privateKey, new TextEncoder().encode(timestamp + body)));
  return new Request("https://bot.example/interactions", {
    method: "POST",
    headers: { "X-Signature-Ed25519": Buffer.from(sig).toString("hex"), "X-Signature-Timestamp": timestamp },
    body: tamper ? body.replace("1", "2") : body,
  });
}

test("answers Discord's PING and rejects bad signatures", async () => {
  const k = await keys();
  const env = { ...ENV, DISCORD_PUBLIC_KEY: k.publicKey, DB: fakeD1() };
  const ok = await worker.fetch(await signed(k, { type: 1 }), env, fakeCtx());
  assert.deepEqual(await ok.json(), { type: 1 });
  const bad = await worker.fetch(await signed(k, { type: 1, id: "1" }, true), env, fakeCtx());
  assert.equal(bad.status, 401);
});

test("/leaderboard posts a one-off board whose buttons flip it", async () => {
  const k = await keys();
  const env = { ...ENV, DISCORD_PUBLIC_KEY: k.publicKey, DB: fakeD1() };
  const calls = installFetch();
  const ctx = fakeCtx();
  const res = await worker.fetch(
    await signed(k, { type: 2, token: "tok", guild_id: "g1", channel_id: "chan1", member: STAFF, data: { name: "leaderboard" } }),
    env,
    ctx,
  );
  assert.equal((await res.json()).type, 5);
  await ctx.done();
  const edit = calls.find((c) => c.method === "PATCH" && c.path.endsWith("@original"));
  assert.match(edit.body.embeds[0].title, /EU/);
  assert.equal(await env.DB.prepare("SELECT * FROM boards").first(), null);

  const ctx2 = fakeCtx();
  const press = await worker.fetch(
    await signed(k, { type: 3, token: "tok2", channel_id: "chan1", message: { id: "some-msg" }, data: { custom_id: "lb:r:na:1" } }),
    env,
    ctx2,
  );
  assert.equal((await press.json()).type, 6); // edits that message
  await ctx2.done();
  assert.match(calls.filter((c) => c.path?.endsWith("@original")).at(-1).body.embeds[0].title, /NA/);
});

test("/setup leaderboard posts a live board; its buttons give the presser a private copy", async () => {
  const k = await keys();
  const env = { ...ENV, DISCORD_PUBLIC_KEY: k.publicKey, DB: fakeD1() };
  const calls = installFetch();
  const setup = (channel) => ({
    type: 2,
    token: "tok",
    guild_id: "g1",
    channel_id: "chan1",
    member: STAFF,
    data: { name: "setup", options: [{ type: 1, name: "leaderboard", options: channel ? [{ type: 7, name: "channel", value: channel }] : [] }] },
  });
  const ctx = fakeCtx();
  const res = await worker.fetch(await signed(k, setup("lb-chan")), env, ctx);
  assert.deepEqual(await res.json(), { type: 5, data: { flags: 64 } });
  await ctx.done();
  const post = calls.find((c) => c.method === "POST" && c.path === "/channels/lb-chan/messages");
  assert.match(post.body.embeds[0].title, /EU Leaderboard — Top 15/);
  assert.match(post.body.embeds[0].footer.text, /^Live · updates every 5 min/);
  const board = await env.DB.prepare("SELECT * FROM boards").first();
  assert.equal(board.channel_id, "lb-chan");
  assert.match(calls.find((c) => c.path?.endsWith("@original")).body.content, /live leaderboard is in <#lb-chan>/);

  // Running it again in the same channel reuses the message.
  const ctx2 = fakeCtx();
  await worker.fetch(await signed(k, setup("lb-chan")), env, ctx2);
  await ctx2.done();
  assert.equal(calls.filter((c) => c.method === "POST" && c.path === "/channels/lb-chan/messages").length, 1);
  assert.ok(calls.some((c) => c.method === "PATCH" && c.path === `/channels/lb-chan/messages/${board.message_id}`));

  // A button on the live board: private answer, the board itself untouched.
  const ctx3 = fakeCtx();
  const press = await worker.fetch(
    await signed(k, { type: 3, token: "tok3", channel_id: "lb-chan", message: { id: board.message_id }, data: { custom_id: "lb:n:eu:2" } }),
    env,
    ctx3,
  );
  assert.deepEqual(await press.json(), { type: 5, data: { flags: 64 } });
  await ctx3.done();
  const priv = calls.filter((c) => c.path === "/webhooks/app1/tok3/messages/@original").at(-1);
  assert.match(priv.body.embeds[0].title, /Top 30/);
});

test("/stats finds a typed name and shows the numbers", async () => {
  const k = await keys();
  const env = { ...ENV, DISCORD_PUBLIC_KEY: k.publicKey, DB: fakeD1() };
  const calls = installFetch();
  const ctx = fakeCtx();
  await worker.fetch(
    await signed(k, { type: 2, token: "tok", data: { name: "stats", options: [{ type: 3, name: "player", value: "fealthy" }] } }),
    env,
    ctx,
  );
  await ctx.done();
  const embed = calls.find((c) => c.path?.endsWith("@original")).body.embeds[0];
  assert.match(embed.title, /^Fealthy — EU/);
  const field = (n) => embed.fields.find((f) => f.name === n)?.value;
  assert.equal(field("Rating"), "**2,000** · Grandmaster");
  assert.equal(field("Rank"), "#1");
  assert.equal(field("Wins"), "48 (40%)");
  assert.equal(field("Kills"), "300 (2.50/round)");
  assert.equal(field("Deflects"), "500 (5.00/round)");
  assert.equal(field("Peak"), "2,087");
  assert.equal(field("Next tier"), "Ascendant in 200");
  assert.match(embed.description, /OldName/);
  assert.equal(embed.url, "https://genjiball.us/player?id=1&region=eu");
});

test("/stats autocomplete lists matching players", async () => {
  const k = await keys();
  const env = { ...ENV, DISCORD_PUBLIC_KEY: k.publicKey, DB: fakeD1() };
  installFetch();
  const res = await worker.fetch(
    await signed(k, { type: 4, data: { name: "stats", options: [{ type: 3, name: "player", value: "ipse", focused: true }] } }),
    env,
    fakeCtx(),
  );
  const data = await res.json();
  assert.equal(data.type, 8);
  assert.deepEqual(data.data.choices, [{ name: "Ipseity · 1990 Grandmaster", value: "2" }]);
});

test("/stats for nobody says so", async () => {
  const k = await keys();
  const env = { ...ENV, DISCORD_PUBLIC_KEY: k.publicKey, DB: fakeD1() };
  const calls = installFetch();
  const ctx = fakeCtx();
  await worker.fetch(
    await signed(k, { type: 2, token: "tok", data: { name: "stats", options: [{ type: 3, name: "player", value: "zzzz" }] } }),
    env,
    ctx,
  );
  await ctx.done();
  assert.match(calls.find((c) => c.path?.endsWith("@original")).body.content, /couldn't find a player called \*\*zzzz/);
});

test("subcommand options are read", () => {
  const { sub, options } = optionsOf({
    name: "host",
    options: [{ type: 1, name: "tournament", options: [{ type: 3, name: "region", value: "na" }, { type: 3, name: "day", value: "saturday" }] }],
  });
  assert.equal(sub, "tournament");
  assert.deepEqual(options, { region: "na", day: "saturday" });
});

// ---------- tourneys ----------

const sync = (env) => {
  const discord = new Discord(env, 45);
  const site = new Site(env);
  return syncTourneys(env, discord, site, () => discord.left - site.calls);
};
const remind = (env, nowMs) => {
  const discord = new Discord(env, 45);
  const site = new Site(env);
  return sendReminders(env, discord, site, () => discord.left - site.calls, nowMs);
};
const START = Date.parse("2026-10-10T18:00:00Z");
const discordCalls = (calls) => calls.filter((c) => !c.site);
const press = (user, id = 3) => ({
  type: 3,
  token: "tok",
  guild_id: "g1",
  channel_id: "tourney-chan",
  member: { user: { id: user }, roles: [], permissions: "0" },
  message: { id: "5000" },
  data: { custom_id: `tr:${id}` },
});

test("a new tourney is announced with its region pinged, then edited only when it changes", async () => {
  const env = { ...ENV, DB: fakeD1() };
  const tourneys = { na: { upcoming: [fakeTourney({ region: "na", notes: "Bring a friend" })] } };
  const calls = installFetch({ tourneys });
  await sync(env);

  const post = calls.find((c) => c.method === "POST" && c.path === "/channels/tourney-chan/messages");
  assert.equal(post.body.content, "<@&role-na>");
  assert.deepEqual(post.body.allowed_mentions, { parse: [], roles: ["role-na"] });
  const embed = post.body.embeds[0];
  assert.equal(embed.title, "🏆 October Cup");
  assert.equal(embed.url, "https://genjiball.us/tourney?id=3");
  assert.match(embed.description, /<t:1791655200:F>/);
  assert.match(embed.description, /Bring a friend/);
  assert.match(embed.description, /Sign up on \[genjiball\.us\]/);
  assert.equal(embed.fields.find((f) => f.name === "Signed up").value, "**4** / 20");
  const [signUp, remindMe] = post.body.components[0].components;
  assert.deepEqual([signUp.style, signUp.label, signUp.url], [5, "Sign up", "https://genjiball.us/tourney?id=3"]);
  assert.equal(remindMe.custom_id, "tr:3");
  assert.equal(calls.filter((c) => c.site).length, 2); // one read per region

  // Nothing changed: no Discord call.
  const before = discordCalls(calls).length;
  await sync(env);
  assert.equal(discordCalls(calls).length, before);

  // More sign-ups: the post is edited, without a ping.
  tourneys.na.upcoming = [fakeTourney({ region: "na", notes: "Bring a friend", signups: { open: true, count: 20, full: true } })];
  await sync(env);
  const edit = calls.find((c) => c.method === "PATCH" && c.path === "/channels/tourney-chan/messages/5000");
  assert.equal(edit.body.embeds[0].fields.find((f) => f.name === "Signed up").value, "**20** / 20 (full)");
  assert.equal(edit.body.content, undefined);
  assert.equal(calls.filter((c) => c.method === "POST").length, 1);
});

test("no channel set: nothing is read or posted; a live tourney is announced without a ping", async () => {
  const tourneys = { eu: { upcoming: [fakeTourney({ status: "live", signups: { open: false, count: 9, full: false } })] } };
  const calls = installFetch({ tourneys });
  await sync({ ...ENV, TOURNEY_CHANNEL_ID: "", DB: fakeD1() });
  assert.equal(calls.length, 0);

  await sync({ ...ENV, DB: fakeD1() });
  const post = calls.find((c) => c.method === "POST");
  assert.equal(post.body.content, undefined);
  assert.deepEqual(post.body.allowed_mentions, { parse: [] });
  assert.deepEqual(post.body.components[0].components.map((b) => b.label), ["Tourney page"]); // no Remind me
});

test("a past tourney that was never announced isn't posted", async () => {
  const calls = installFetch({ tourneys: { eu: { past: [fakeTourney({ status: "done" })] } } });
  await sync({ ...ENV, DB: fakeD1() });
  assert.equal(discordCalls(calls).length, 0);
});

test("a finished tourney: its post says so and the standings are posted once, under it", async () => {
  const env = { ...ENV, DB: fakeD1() };
  const tourneys = { eu: { upcoming: [fakeTourney()] } };
  const calls = installFetch({ tourneys });
  await sync(env);

  const standings = [
    { place: 1, id: 1, name: "Fealthy", wins: 7, kills: 20 },
    { place: 2, id: 2, name: "Ipse_ity", wins: 5, kills: 1 },
    { place: 2, id: 5, name: "Kenzo", wins: 5, kills: 1 },
    { place: 4, id: 6, name: "Mau", wins: 1, kills: 3 },
  ];
  const [l1, l2] = fakeTourney().lobbies;
  const done = (lobbies) => fakeTourney({ status: "done", signups: { open: false, count: 18, full: false }, lobbies });
  tourneys.eu = { upcoming: [], past: [done([{ ...l1, matchId: 10, standings, verified: true }, { ...l2, matchId: 11, void: true, standings }])] };
  await sync(env);

  const edit = calls.find((c) => c.method === "PATCH" && c.path === "/channels/tourney-chan/messages/5000");
  assert.match(edit.body.embeds[0].description, /Finished/);
  assert.deepEqual(edit.body.components[0].components.map((b) => b.label), ["Tourney page"]);
  const results = calls.filter((c) => c.method === "POST" && c.body?.embeds?.[0]?.title?.includes("standings"));
  assert.equal(results.length, 1);
  assert.equal(results[0].body.message_reference.message_id, "5000");
  const fields = results[0].body.embeds[0].fields;
  assert.equal(fields.length, 1); // the void lobby is left out
  assert.equal(fields[0].name, "Lobby 1 · ✅ verified");
  assert.equal(
    fields[0].value,
    "🥇 **Fealthy** — 7 wins · 20 kills\n🥈 **Ipse\\_ity** — 5 wins · 1 kill\n🥈 **Kenzo** — 5 wins · 1 kill\n`4.` **Mau** — 1 win · 3 kills",
  );
  assert.deepEqual(results[0].body.allowed_mentions, { parse: [] });

  // Again unchanged: nothing. Lobby 2 un-voided: the standings message is edited, not posted again.
  const before = discordCalls(calls).length;
  await sync(env);
  assert.equal(discordCalls(calls).length, before);
  tourneys.eu.past = [done([{ ...l1, matchId: 10, standings, verified: true }, { ...l2, matchId: 11, standings }])];
  await sync(env);
  const resultsEdit = calls.filter((c) => c.method === "PATCH" && c.path === `/channels/tourney-chan/messages/5001`);
  assert.equal(resultsEdit.at(-1).body.embeds[0].fields.length, 2);
  assert.equal(calls.filter((c) => c.method === "POST" && c.body?.embeds?.[0]?.title?.includes("standings")).length, 1);
});

test("Remind me toggles a DM; the DMs go out 5 minutes before, closed DMs named", async () => {
  const k = await keys();
  const env = { ...ENV, DISCORD_PUBLIC_KEY: k.publicKey, DB: fakeD1() };
  const calls = installFetch({ tourneys: { eu: { upcoming: [fakeTourney()] } }, closedDms: new Set(["u3"]) });
  await sync(env);

  const answer = async (user) => (await (await worker.fetch(await signed(k, press(user)), env, fakeCtx())).json()).data;
  const first = await answer("u1");
  assert.equal(first.flags, 64);
  assert.match(first.content, /I'll DM you 5 minutes before \*\*October Cup\*\*/);
  assert.match(first.content, /doesn't sign you up/);
  await answer("u2");
  await answer("u3");
  await answer("u4");
  assert.match((await answer("u4")).content, /no DM/); // pressed twice: off again

  // Too early: nothing.
  const before = discordCalls(calls).length;
  await remind(env, START - 10 * 60_000);
  assert.equal(discordCalls(calls).length, before);

  await remind(env, START - 5 * 60_000);
  const dms = calls.filter((c) => c.method === "POST" && c.path.startsWith("/channels/dm-"));
  assert.deepEqual(dms.map((d) => d.path), ["/channels/dm-u1/messages", "/channels/dm-u2/messages", "/channels/dm-u3/messages"]);
  assert.match(dms[0].body.content, /October Cup.*starts <t:1791655200:R>/);
  assert.match(dms[0].body.content, /https:\/\/genjiball\.us\/tourney\?id=3/);
  assert.doesNotMatch(dms[0].body.content, /1\.3\.3/);
  const note = calls.find((c) => c.body?.content?.startsWith("Couldn't DM"));
  assert.equal(note.path, "/channels/tourney-chan/messages");
  assert.deepEqual(note.body.allowed_mentions, { parse: [], users: ["u3"] });
  assert.equal((await env.DB.prepare("SELECT reminded FROM tourneys").first()).reminded, 1);

  // Later runs do nothing more; a late press says the reminders went out.
  const after = discordCalls(calls).length;
  await remind(env, START);
  assert.equal(discordCalls(calls).length, after);
  assert.match((await answer("u5")).content, /already went out/);
});

test("a tourney moved after its reminders went out reminds again, except closed DMs", async () => {
  const env = { ...ENV, DB: fakeD1() };
  const tourneys = { eu: { upcoming: [fakeTourney()] } };
  const calls = installFetch({ tourneys, closedDms: new Set(["u2"]) });
  await sync(env);
  for (const u of ["u1", "u2"]) await env.DB.prepare("INSERT INTO reminders (tourney_id, user_id, channel_id) VALUES (3, ?, 'tourney-chan')").bind(u).run();
  await remind(env, START - 5 * 60_000);
  assert.equal((await env.DB.prepare("SELECT reminded FROM tourneys").first()).reminded, 1);

  const later = Date.parse("2026-10-10T20:00:00Z");
  tourneys.eu.upcoming = [fakeTourney({ startsAt: "2026-10-10T20:00:00Z" })];
  await sync(env);
  assert.equal((await env.DB.prepare("SELECT reminded FROM tourneys").first()).reminded, 0);
  const before = calls.filter((c) => c.path?.startsWith("/channels/dm-")).length;
  await remind(env, later - 5 * 60_000);
  const dms = calls.filter((c) => c.path?.startsWith("/channels/dm-")).slice(before);
  assert.deepEqual(dms.map((d) => d.path), ["/channels/dm-u1/messages"]);
});

test("a big tourney's reminders spread over several cron runs", async () => {
  const env = { ...ENV, DB: fakeD1() };
  const calls = installFetch({ tourneys: { eu: { upcoming: [fakeTourney()] } } });
  await sync(env);
  for (let i = 0; i < 70; i++) {
    await env.DB.prepare("INSERT INTO reminders (tourney_id, user_id, channel_id) VALUES (3, ?, 'tourney-chan')").bind(`p${i}`).run();
  }
  let runs = 0;
  while (!(await env.DB.prepare("SELECT reminded FROM tourneys").first()).reminded && runs < 10) {
    await remind(env, START - (5 - runs) * 60_000);
    runs++;
  }
  const dms = calls.filter((c) => c.method === "POST" && c.path.startsWith("/channels/dm-"));
  assert.equal(dms.length, 70);
  assert.ok(runs >= 3 && runs <= 5, `took ${runs} runs`);
  assert.equal(new Set(dms.map((d) => d.path)).size, 70); // nobody DMed twice
});

test("a cancelled tourney: post greyed out, no DMs, Remind me says so", async () => {
  const k = await keys();
  const env = { ...ENV, DISCORD_PUBLIC_KEY: k.publicKey, DB: fakeD1() };
  const tourneys = { eu: { upcoming: [fakeTourney()] } };
  const calls = installFetch({ tourneys });
  await sync(env);
  await worker.fetch(await signed(k, press("u1")), env, fakeCtx());

  tourneys.eu = { upcoming: [], past: [fakeTourney({ status: "cancelled", signups: { open: false, count: 4, full: false } })] };
  await sync(env);
  const edit = calls.find((c) => c.method === "PATCH");
  assert.match(edit.body.embeds[0].title, /~~🏆 October Cup~~ — Cancelled/);
  assert.equal(edit.body.embeds[0].color, 0x808080);

  await remind(env, START - 5 * 60_000);
  assert.ok(!calls.some((c) => c.path?.startsWith("/channels/dm-")));
  const res = await worker.fetch(await signed(k, press("u2")), env, fakeCtx());
  assert.match((await res.json()).data.content, /was cancelled/);
});

test("Remind me on an unknown or started tourney says so", async () => {
  const k = await keys();
  const env = { ...ENV, DISCORD_PUBLIC_KEY: k.publicKey, DB: fakeD1() };
  installFetch({ tourneys: { eu: { upcoming: [fakeTourney({ startsAt: "2020-01-01T00:00:00Z" })] } } });
  await sync(env);
  const ask = async (id) => (await (await worker.fetch(await signed(k, press("u1", id)), env, fakeCtx())).json()).data.content;
  assert.match(await ask(3), /already started/);
  assert.match(await ask(99), /don't know that tourney/);
});

test("/host points to the site's tourneys", async () => {
  const k = await keys();
  const env = { ...ENV, DISCORD_PUBLIC_KEY: k.publicKey, DB: fakeD1() };
  const calls = installFetch();
  const res = await worker.fetch(
    await signed(k, { type: 2, token: "tok", guild_id: "g1", member: STAFF, data: { name: "host", options: [{ type: 1, name: "tournament", options: [] }] } }),
    env,
    fakeCtx(),
  );
  const data = await res.json();
  assert.equal(data.type, 4);
  assert.equal(data.data.flags, 64);
  assert.match(data.data.content, /genjiball\.us.*<#tourney-chan>/s);
  assert.equal(calls.length, 0);
});

test("the cron syncs tourneys every 5 minutes", async () => {
  const env = { ...ENV, DB: fakeD1() };
  const calls = installFetch({ tourneys: { eu: { upcoming: [fakeTourney()] } } });
  await worker.scheduled({ scheduledTime: Date.UTC(2026, 9, 6, 10, 7) }, env, fakeCtx());
  assert.ok(!calls.some((c) => c.path?.startsWith("/api/tourneys")));
  await worker.scheduled({ scheduledTime: Date.UTC(2026, 9, 6, 10, 10) }, env, fakeCtx());
  assert.ok(calls.some((c) => c.method === "POST" && c.path === "/channels/tourney-chan/messages"));
});

test("the cron refreshes live boards every 5 minutes and drops deleted ones", async () => {
  const env = { ...ENV, DB: fakeD1() };
  await env.DB.prepare("INSERT INTO boards (channel_id, guild_id, message_id) VALUES ('chan1','g1','board-msg')").run();
  await env.DB.prepare("INSERT INTO boards (channel_id, guild_id, message_id) VALUES ('gone','g1','deleted-msg')").run();
  const calls = installFetch();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    if (String(input).includes("/channels/gone/")) return new Response(JSON.stringify({ message: "Unknown Message", code: 10008 }), { status: 404 });
    return realFetch(input, init);
  };
  await worker.scheduled({ scheduledTime: Date.UTC(2026, 9, 6, 10, 7) }, env, fakeCtx());
  assert.ok(!calls.some((c) => c.path === "/channels/chan1/messages/board-msg"));
  await worker.scheduled({ scheduledTime: Date.UTC(2026, 9, 6, 10, 10) }, env, fakeCtx());
  const edit = calls.find((c) => c.path === "/channels/chan1/messages/board-msg");
  assert.match(edit.body.embeds[0].title, /EU Leaderboard — Top 15/);
  assert.deepEqual((await env.DB.prepare("SELECT channel_id FROM boards").all()).results.map((r) => r.channel_id), ["chan1"]);
});

test("only Staff (or admins) can use /setup and /leaderboard; everyone can use /stats", async () => {
  const k = await keys();
  const env = { ...ENV, DISCORD_PUBLIC_KEY: k.publicKey, DB: fakeD1() };
  const calls = installFetch();
  const player = { user: { id: "someone" }, roles: ["role-eu"], permissions: "0" };
  const cmd = (name, member) => ({ type: 2, token: "tok", guild_id: "g1", channel_id: "chan1", member, data: { name } });
  for (const name of ["setup", "leaderboard"]) {
    const res = await worker.fetch(await signed(k, cmd(name, player)), env, fakeCtx());
    const data = await res.json();
    assert.equal(data.type, 4);
    assert.equal(data.data.flags, 64);
    assert.match(data.data.content, /Only \*\*Staff\*\*/);
  }
  assert.ok(!calls.some((c) => !c.site)); // nothing posted

  const admin = { user: { id: "owner" }, roles: [], permissions: String(1n << 3n) };
  const ok = await worker.fetch(await signed(k, cmd("leaderboard", admin)), env, fakeCtx());
  assert.equal((await ok.json()).type, 5);

  const stats = await worker.fetch(
    await signed(k, { type: 2, token: "t", guild_id: "g1", member: player, data: { name: "stats", options: [{ type: 3, name: "player", value: "fealthy" }] } }),
    env,
    fakeCtx(),
  );
  assert.equal((await stats.json()).type, 5);
});
