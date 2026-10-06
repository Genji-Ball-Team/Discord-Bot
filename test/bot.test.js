import assert from "node:assert/strict";
import { test } from "node:test";
import worker, { optionsOf } from "../src/index.js";
import { fetchRanks, formatLines, parseButton, renderLeaderboard } from "../src/leaderboard.js";
import { Site } from "../src/site.js";
import { nextStart, parseTime } from "../src/time.js";
import { Discord } from "../src/discord.js";
import { listMessages, runReminders } from "../src/tournament.js";
import { ENV, STAFF, fakeCtx, fakeD1, installFetch } from "./helpers.js";

// ---------- time ----------

test("reads times people type", () => {
  assert.deepEqual(parseTime("21:00"), { hour: 21, minute: 0 });
  assert.deepEqual(parseTime("9pm"), { hour: 21, minute: 0 });
  assert.deepEqual(parseTime("9:30 PM"), { hour: 21, minute: 30 });
  assert.deepEqual(parseTime("12am"), { hour: 0, minute: 0 });
  assert.deepEqual(parseTime("20.15"), { hour: 20, minute: 15 });
  assert.equal(parseTime("25:00"), null);
  assert.equal(parseTime("13pm"), null);
  assert.equal(parseTime("soon"), null);
});

test("NA Saturday 21:00 is 9pm New York time, EST or EDT", () => {
  // Tue 6 Oct 2026, 10:00 UTC. NY is on EDT (UTC-4) until 1 Nov.
  const now = Date.UTC(2026, 9, 6, 10, 0);
  assert.equal(new Date(nextStart("saturday", { hour: 21, minute: 0 }, "America/New_York", now)).toISOString(), "2026-10-11T01:00:00.000Z");
  // After the clocks go back (EST, UTC-5).
  const nov = Date.UTC(2026, 10, 3, 10, 0);
  assert.equal(new Date(nextStart("saturday", { hour: 21, minute: 0 }, "America/New_York", nov)).toISOString(), "2026-11-08T02:00:00.000Z");
});

test("EU 21:00 is 9pm Moscow time (UTC+3)", () => {
  const now = Date.UTC(2026, 9, 6, 10, 0); // Tuesday
  assert.equal(new Date(nextStart("saturday", { hour: 21, minute: 0 }, "Europe/Moscow", now)).toISOString(), "2026-10-10T18:00:00.000Z");
  assert.equal(new Date(nextStart("today", { hour: 21, minute: 0 }, "Europe/Moscow", now)).toISOString(), "2026-10-06T18:00:00.000Z");
  assert.equal(new Date(nextStart("tomorrow", { hour: 21, minute: 0 }, "Europe/Moscow", now)).toISOString(), "2026-10-07T18:00:00.000Z");
});

test("a weekday that's today but already past means next week", () => {
  const tuesdayLate = Date.UTC(2026, 9, 6, 19, 0); // 22:00 Moscow
  assert.equal(new Date(nextStart("tuesday", { hour: 21, minute: 0 }, "Europe/Moscow", tuesdayLate)).toISOString(), "2026-10-13T18:00:00.000Z");
  const tuesdayEarly = Date.UTC(2026, 9, 6, 10, 0);
  assert.equal(new Date(nextStart("tuesday", { hour: 21, minute: 0 }, "Europe/Moscow", tuesdayEarly)).toISOString(), "2026-10-06T18:00:00.000Z");
});

// ---------- leaderboard ----------

test("page 4 (ranks 46–60) reads API pages 1 and 2", async () => {
  const calls = installFetch();
  const { players, more } = await fetchRanks(new Site(ENV), "eu", 46, 60);
  assert.deepEqual(players.map((p) => p.rank), [46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60]);
  assert.equal(more, true);
  assert.equal(calls.filter((c) => c.site).length, 2);
});

test("lines look like '1. Fealthy 2000'", () => {
  const lines = formatLines([
    { rank: 1, name: "Fealthy", rating: 2000.4 },
    { rank: 2, name: "Ipseity", rating: 1600 },
  ]);
  assert.deepEqual(lines, ["1.  Fealthy 2000", "2.  Ipseity 1600"]);
});

test("buttons: EU default, NA switch, pages up to 5, ids unique", async () => {
  installFetch();
  const { message } = await renderLeaderboard(new Site(ENV), undefined, undefined);
  const [regionRow, pageRow] = message.components;
  assert.match(message.embeds[0].title, /EU Leaderboard — Top 15/);
  assert.match(message.embeds[0].description, /1\. {2}Fealthy/);
  assert.equal(regionRow.components[0].disabled, true); // EU is current
  assert.equal(pageRow.components[0].disabled, true); // no Prev on page 1
  const ids = [...regionRow.components, ...pageRow.components].map((b) => b.custom_id);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(parseButton(regionRow.components[1].custom_id), { region: "na", page: 1 });
  assert.deepEqual(parseButton(pageRow.components[2].custom_id), { region: "eu", page: 2 });

  const last = await renderLeaderboard(new Site(ENV), "na", 5);
  assert.match(last.message.embeds[0].title, /NA Leaderboard — Top 75/);
  assert.match(last.message.embeds[0].description, /^```\n61\./);
  assert.equal(last.message.components[1].components[2].disabled, true); // no page 6
});

test("Next is off when fewer players than the next page", async () => {
  installFetch({ boardTotal: 20 });
  const { message } = await renderLeaderboard(new Site(ENV), "eu", 2);
  assert.equal(message.components[1].components[2].disabled, true);
  assert.equal(message.embeds[0].description.split("\n").length, 2 + 5); // ranks 16–20
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
  assert.match(embed.title, /^Fealthy — 🇪🇺 EU/);
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

// ---------- tournaments ----------

const hostCmd = (opts) => ({
  type: 2,
  token: "tok",
  guild_id: "g1",
  channel_id: "tourney-chan",
  member: STAFF,
  data: { name: "host", options: [{ type: 1, name: "tournament", options: Object.entries(opts).map(([name, value]) => ({ type: 3, name, value })) }] },
});

test("/host tournament: post, sign-ups, list, DMs, the closed DM noted", async () => {
  const k = await keys();
  const env = { ...ENV, DISCORD_PUBLIC_KEY: k.publicKey, DB: fakeD1() };
  const users = [
    { id: "u1", username: "fealthy", global_name: "Fealthy" },
    { id: "bot", username: "GenjiBot", bot: true },
    { id: "u2", username: "ipseity" },
    { id: "u3", username: "closed" },
  ];
  const calls = installFetch({ reactors: { 5000: users }, closedDms: new Set(["u3"]) });
  const ctx = fakeCtx();
  await worker.fetch(await signed(k, hostCmd({ region: "na", day: "saturday" })), env, ctx);
  await ctx.done();

  const post = calls.find((c) => c.method === "POST" && c.path === "/channels/tourney-chan/messages");
  assert.equal(post.body.content, "<@&role-na>");
  assert.deepEqual(post.body.allowed_mentions, { parse: [], roles: ["role-na"] });
  assert.match(post.body.embeds[0].description, /<t:\d+:F>/);
  assert.ok(calls.some((c) => c.method === "PUT" && c.path.includes("/reactions/%E2%9C%85/@me")));
  const reply = calls.find((c) => c.path?.endsWith("@original")).body.content;
  assert.match(reply, /Posted the NA sign-ups/);

  const t = await env.DB.prepare("SELECT * FROM tournaments").first();
  assert.equal(t.status, "open");
  assert.equal(t.message_id, "5000");
  const weekday = new Date(t.starts_at * 1000).toLocaleDateString("en-US", { timeZone: "America/New_York", weekday: "long", hour: "numeric", hour12: false });
  assert.match(weekday, /Saturday.*21/);

  // Too early: nothing happens.
  const before = calls.length;
  await runReminders(env, new Discord(env, 45), t.starts_at * 1000 - 10 * 60_000);
  assert.equal(calls.length, before);

  // 5 minutes before: list posted, DMs sent.
  await runReminders(env, new Discord(env, 45), t.starts_at * 1000 - 5 * 60_000);
  const list = calls.find((c) => c.method === "POST" && c.body?.content?.startsWith("📋"));
  assert.match(list.body.content, /\*\*3\*\* signed up:\n1\. <@u1>\n2\. <@u2>\n3\. <@u3>$/);
  assert.deepEqual(list.body.allowed_mentions, { parse: [] });
  const dms = calls.filter((c) => c.method === "POST" && c.path.startsWith("/channels/dm-"));
  assert.equal(dms.length, 3); // u3's was refused
  assert.match(dms[0].body.content, /Genji Ball 1\.3\.3/);
  const note = calls.find((c) => c.body?.content?.startsWith("Couldn't DM"));
  assert.match(note.body.content, /<@u3>/);
  assert.equal((await env.DB.prepare("SELECT status FROM tournaments").first()).status, "done");
  const statuses = (await env.DB.prepare("SELECT user_id, dm_status FROM signups ORDER BY user_id").all()).results;
  assert.deepEqual(statuses.map((s) => s.dm_status), ["sent", "sent", "failed"]);

  // Later runs do nothing more.
  const after = calls.length;
  await runReminders(env, new Discord(env, 45), t.starts_at * 1000);
  assert.equal(calls.length, after);
});

test("a big tournament's DMs spread over several cron runs", async () => {
  const env = { ...ENV, DB: fakeD1() };
  const users = Array.from({ length: 70 }, (_, i) => ({ id: `p${i}`, username: `p${i}` }));
  const calls = installFetch({ reactors: { m1: users } });
  const start = Math.floor(Date.UTC(2026, 9, 10, 18, 0) / 1000);
  await env.DB.prepare("INSERT INTO tournaments (guild_id, channel_id, message_id, region, name, starts_at, created_by, created_at) VALUES ('g','c','m1','eu','EU Weekly Tournament',?,'me',0)")
    .bind(start)
    .run();
  let runs = 0;
  while ((await env.DB.prepare("SELECT status FROM tournaments").first()).status !== "done" && runs < 10) {
    await runReminders(env, new Discord(env, 45), start * 1000 - (5 - runs) * 60_000);
    runs++;
  }
  const dms = calls.filter((c) => c.method === "POST" && c.path.startsWith("/channels/dm-"));
  assert.equal(dms.length, 70);
  assert.ok(runs >= 3 && runs <= 5, `took ${runs} runs`);
  assert.equal(new Set(dms.map((d) => d.path)).size, 70); // nobody DMed twice
});

test("a long sign-up list splits under Discord's limit", () => {
  const users = Array.from({ length: 150 }, (_, i) => ({ id: String(100000000000000000n + BigInt(i)) }));
  const parts = listMessages("header", users);
  assert.ok(parts.length > 1);
  for (const p of parts) assert.ok(p.length <= 2000);
  assert.equal(parts.join("\n").match(/<@/g).length, 150);
});

test("/host tournament refuses a start that's too close", async () => {
  const k = await keys();
  const env = { ...ENV, DISCORD_PUBLIC_KEY: k.publicKey, DB: fakeD1() };
  const calls = installFetch();
  const ctx = fakeCtx();
  // "today" at a time that's already past in Moscow lands in the past → refused.
  await worker.fetch(await signed(k, hostCmd({ region: "eu", day: "today", time: "00:01" })), env, ctx);
  await ctx.done();
  assert.match(calls.find((c) => c.path?.endsWith("@original")).body.content, /too soon/);
  assert.equal(await env.DB.prepare("SELECT * FROM tournaments").first(), null);
});

test("/host cancel marks the next one cancelled and edits the post", async () => {
  const k = await keys();
  const env = { ...ENV, DISCORD_PUBLIC_KEY: k.publicKey, DB: fakeD1() };
  const calls = installFetch();
  const ctx = fakeCtx();
  await worker.fetch(await signed(k, hostCmd({ region: "eu", day: "sunday", time: "9pm", name: "Big Cup" })), env, ctx);
  await ctx.done();
  const ctx2 = fakeCtx();
  await worker.fetch(
    await signed(k, { ...hostCmd({}), data: { name: "host", options: [{ type: 1, name: "cancel", options: [{ type: 3, name: "region", value: "eu" }] }] } }),
    env,
    ctx2,
  );
  await ctx2.done();
  assert.equal((await env.DB.prepare("SELECT status FROM tournaments").first()).status, "cancelled");
  const edit = calls.find((c) => c.method === "PATCH" && c.path === "/channels/tourney-chan/messages/5000");
  assert.match(edit.body.embeds[0].title, /Big Cup.*Cancelled/);
  await runReminders(env, new Discord(env, 45), Date.now() + 8 * 86400_000);
  assert.ok(!calls.some((c) => c.body?.content?.startsWith("📋")));
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

test("only Staff (or admins) can use /host, /setup and /leaderboard; everyone can use /stats", async () => {
  const k = await keys();
  const env = { ...ENV, DISCORD_PUBLIC_KEY: k.publicKey, DB: fakeD1() };
  const calls = installFetch();
  const player = { user: { id: "someone" }, roles: ["role-eu"], permissions: "0" };
  for (const name of ["host", "setup", "leaderboard"]) {
    const res = await worker.fetch(await signed(k, { ...hostCmd({ region: "eu", day: "saturday" }), member: player, data: { ...hostCmd({}).data, name } }), env, fakeCtx());
    const data = await res.json();
    assert.equal(data.type, 4);
    assert.equal(data.data.flags, 64);
    assert.match(data.data.content, /Only \*\*Staff\*\*/);
  }
  assert.ok(!calls.some((c) => !c.site)); // nothing posted

  const admin = { user: { id: "owner" }, roles: [], permissions: String(1n << 3n) };
  const ok = await worker.fetch(await signed(k, { ...hostCmd({ region: "eu", day: "saturday" }), member: admin }), env, fakeCtx());
  assert.equal((await ok.json()).type, 5);

  const stats = await worker.fetch(
    await signed(k, { type: 2, token: "t", guild_id: "g1", member: player, data: { name: "stats", options: [{ type: 3, name: "player", value: "fealthy" }] } }),
    env,
    fakeCtx(),
  );
  assert.equal((await stats.json()).type, 5);
});
