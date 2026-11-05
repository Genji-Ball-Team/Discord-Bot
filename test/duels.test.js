import assert from "node:assert/strict";
import { test } from "node:test";
import { duelLine } from "../src/duels.js";
import worker from "../src/index.js";
import { ENV, fakeD1, installFetch } from "./helpers.js";

const CHANNEL = "ranked-results";
const env = () => ({ ...ENV, DB: fakeD1(), DUELS_CHANNEL_ID: CHANNEL });
// 10:02 UTC: the results and duels beat.
const cron = (e, minute = 2) => worker.scheduled({ scheduledTime: Date.UTC(2026, 10, 5, 10, minute) }, e);
const posts = (calls) => calls.filter((c) => c.method === "POST" && c.path === `/channels/${CHANNEL}/messages`);
const edits = (calls) => calls.filter((c) => c.method === "PATCH" && c.path.startsWith(`/channels/${CHANNEL}/messages/`));
const deletes = (calls) => calls.filter((c) => c.method === "DELETE" && c.path.startsWith(`/channels/${CHANNEL}/messages/`));

const side = (id, name, before, after) => ({ id, name, ratingBefore: before, ratingAfter: after });
const duel = (id, winner, loser, loserScore = 8, rated = true) => ({
  id,
  playedAt: "2026-11-05T10:00:00Z",
  winnerScore: 15,
  loserScore,
  rated,
  winner: side(1, winner, rated ? 1612.4 : null, rated ? 1623.2 : null),
  loser: side(2, loser, rated ? 1540 : null, rated ? 1529 : null),
});

test("duels: a line with the region, both names, the score and both changes", () => {
  assert.equal(duelLine("eu", duel(1, "MrMarlow", "Lipton")), "⚔️ EU · **MrMarlow** beat **Lipton** 15–8 · **+11** / **−11**");
  assert.equal(duelLine("na", duel(1, "*Star*", "Lipton", 3, false)), "⚔️ NA · **\\*Star\\*** beat **Lipton** 15–3 · not rated");
});

test("duels: the first run posts nothing, then new duels go in one message per region, oldest first", async () => {
  const e = env();
  const duels = { eu: [duel(10, "Old", "Duel")], na: [] };
  const calls = installFetch({ duels });
  await cron(e);
  assert.equal(posts(calls).length, 0);
  assert.ok(calls.some((c) => c.site && c.path === "/api/duels?region=eu"));
  assert.ok(calls.some((c) => c.site && c.path === "/api/duels?region=na"));

  duels.eu.push(duel(12, "Muddie", "Ayashiru", 12), duel(11, "MrMarlow", "Lipton"));
  duels.na.push(duel(13, "NaKing", "Ipseity"));
  await cron(e);
  assert.equal(posts(calls).length, 2);
  const [eu, na] = posts(calls).map((c) => c.body);
  assert.equal(
    eu.content,
    "⚔️ EU · **MrMarlow** beat **Lipton** 15–8 · **+11** / **−11**\n⚔️ EU · **Muddie** beat **Ayashiru** 15–12 · **+11** / **−11**",
  );
  assert.equal(na.content, "⚔️ NA · **NaKing** beat **Ipseity** 15–8 · **+11** / **−11**");
  assert.deepEqual(eu.allowed_mentions, { parse: [] });
  assert.equal(eu.embeds, undefined);

  // Nothing new: nothing posted.
  await cron(e);
  assert.equal(posts(calls).length, 2);
});

test("duels: only on the 5-minute beat", async () => {
  const e = env();
  const calls = installFetch({ duels: { eu: [] } });
  await cron(e, 1);
  assert.ok(!calls.some((c) => c.site && c.path.startsWith("/api/duels")));
});

test("duels: a voided duel's line is taken out, and the message deleted when none is left", async () => {
  const e = env();
  const duels = { eu: [], na: [] };
  const calls = installFetch({ duels });
  await cron(e);
  duels.eu.push(duel(1, "A", "B"), duel(2, "C", "D"));
  await cron(e);
  assert.equal(posts(calls).length, 1);
  const messageId = "5000";

  duels.eu = duels.eu.filter((d) => d.id !== 1);
  await cron(e);
  assert.equal(edits(calls).length, 1);
  assert.equal(edits(calls)[0].path, `/channels/${CHANNEL}/messages/${messageId}`);
  assert.equal(edits(calls)[0].body.content, "⚔️ EU · **C** beat **D** 15–8 · **+11** / **−11**");

  duels.eu = [];
  await cron(e);
  assert.equal(deletes(calls).length, 1);
  assert.equal(deletes(calls)[0].path, `/channels/${CHANNEL}/messages/${messageId}`);
  assert.equal(posts(calls).length, 1);
});

test("duels: many at once are split under Discord's 2000 characters", async () => {
  const e = env();
  const duels = { eu: [], na: [] };
  const calls = installFetch({ duels });
  await cron(e);
  duels.eu = Array.from({ length: 30 }, (_, i) => duel(i + 1, `LongPlayerName${i}`.padEnd(32, "x"), `OtherLongName${i}`.padEnd(32, "y")));
  await cron(e);
  assert.ok(posts(calls).length > 1);
  for (const p of posts(calls)) assert.ok(p.body.content.length <= 2000);
  assert.equal(posts(calls).flatMap((p) => p.body.content.split("\n")).length, 30);
});

test("duels: off without DUELS_CHANNEL_ID, and a site error posts nothing", async () => {
  let calls = installFetch({ duels: { eu: [duel(1, "A", "B")] } });
  await cron({ ...ENV, DB: fakeD1() });
  assert.ok(!calls.some((c) => c.site && c.path.startsWith("/api/duels")));

  const e = env();
  calls = installFetch({ duels: { eu: [] }, siteDown: true });
  await cron(e);
  assert.equal(posts(calls).length, 0);
});
