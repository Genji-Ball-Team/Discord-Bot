import assert from "node:assert/strict";
import { test } from "node:test";
import worker from "../src/index.js";
import { ENV, fakeD1, installFetch } from "./helpers.js";

const CHANNEL = "lobby-status";
const env = () => ({ ...ENV, DB: fakeD1(), LOBBY_STATUS_CHANNEL_ID: CHANNEL, LOBBY_STATUS_REGION: "eu" });
// 10:01 UTC: no tourney, results or leaderboard work that minute, only the lobby status and ranks.
const cron = (e) => worker.scheduled({ scheduledTime: Date.UTC(2026, 9, 6, 10, 1) }, e);
const posts = (calls) => calls.filter((c) => c.method === "POST" && c.path === `/channels/${CHANNEL}/messages`);
const edits = (calls) => calls.filter((c) => c.method === "PATCH" && c.path.startsWith(`/channels/${CHANNEL}/messages/`));
const embedOf = (call) => call.body.embeds[0];
const lobby = (names) => ({ hostName: "FealthyC", name: "EU ranked night", players: names.length, names, openedAt: "2026-10-06T09:40:00Z" });

test("lobby status: posted once, then edited only when it changes, pinging nobody", async () => {
  const e = env();
  const lobbies = { eu: [] };
  const calls = installFetch({ lobbies });

  await cron(e);
  assert.equal(posts(calls).length, 1);
  const offline = embedOf(posts(calls)[0]);
  assert.equal(offline.title, "🇪🇺 EU Lobby Status");
  assert.equal(offline.url, "https://genjiball.us/live?region=eu");
  assert.match(offline.description, /Status: \*\*Offline\*\* ❌/);
  assert.deepEqual(posts(calls)[0].body.allowed_mentions, { parse: [] });
  assert.ok(calls.some((c) => c.site && c.path === "/api/lobbies?region=eu"));

  // Nothing changed: no edit.
  await cron(e);
  assert.equal(posts(calls).length + edits(calls).length, 1);

  lobbies.eu = [lobby(["FealthyC", "Tidal", "Mochi", "Ghost", "Nova", "Sparrow"])];
  await cron(e);
  assert.equal(posts(calls).length, 1);
  assert.equal(edits(calls).length, 1);
  // The posted message is the one edited.
  assert.equal(edits(calls)[0].path, `/channels/${CHANNEL}/messages/${5000}`);
  const active = embedOf(edits(calls)[0]);
  assert.equal(
    active.description,
    "Status: **Active** ✅\n\n👥 **6 Current Players**\n1. FealthyC\n2. Tidal\n3. Mochi\n4. Ghost\n5. Nova\n6. Sparrow",
  );
  // The lobby's name and host aren't shown.
  assert.doesNotMatch(active.description, /ranked night|Hosted/);
  assert.notEqual(active.color, offline.color);
});

test("lobby status: one player, markdown escaped, and a host tool too old to send names", async () => {
  const e = env();
  const lobbies = { eu: [lobby(["*Star*_x"])] };
  const calls = installFetch({ lobbies });
  await cron(e);
  assert.equal(embedOf(posts(calls)[0]).description, "Status: **Active** ✅\n\n👥 **1 Current Player**\n1. \\*Star\\*\\_x");

  lobbies.eu = [{ ...lobby([]), players: 4, names: undefined }];
  await cron(e);
  assert.equal(embedOf(edits(calls)[0]).description, "Status: **Active** ✅\n\n👥 **4 Current Players**");
});

test("lobby status: two lobbies at once are listed apart", async () => {
  const e = env();
  const calls = installFetch({ lobbies: { eu: [lobby(["A", "B"]), lobby(["C"])] } });
  await cron(e);
  assert.equal(
    embedOf(posts(calls)[0]).description,
    "Status: **Active** ✅\n\n**Lobby 1**\n👥 **2 Current Players**\n1. A\n2. B\n\n**Lobby 2**\n👥 **1 Current Player**\n1. C",
  );
});

test("lobby status: a deleted message is posted again; a site error changes nothing", async () => {
  const e = env();
  const lobbies = { eu: [] };
  let deleted = false;
  let calls = installFetch({ lobbies, discordDown: ({ method }) => (deleted && method === "PATCH" ? 404 : false) });
  await cron(e);
  assert.equal(posts(calls).length, 1);

  deleted = true;
  lobbies.eu = [lobby(["A"])];
  await cron(e);
  assert.equal(posts(calls).length, 2);
  assert.match(embedOf(posts(calls)[1]).description, /Active/);

  // The new message is the one edited from then on.
  deleted = false;
  lobbies.eu = [];
  await cron(e);
  assert.equal(edits(calls).at(-1).path, `/channels/${CHANNEL}/messages/${5001}`);

  calls = installFetch({ lobbies: { eu: [lobby(["A"])] }, siteDown: true });
  await cron(e);
  assert.equal(posts(calls).length + edits(calls).length, 0);
});

test("lobby status: off without a channel, and shows NA when set", async () => {
  let calls = installFetch({ lobbies: { eu: [lobby(["A"])] } });
  await cron({ ...ENV, DB: fakeD1() });
  assert.ok(!calls.some((c) => c.site && c.path.startsWith("/api/lobbies")));

  calls = installFetch({ lobbies: { na: [lobby(["B"])] } });
  await cron({ ...env(), LOBBY_STATUS_REGION: "na" });
  const embed = embedOf(posts(calls)[0]);
  assert.equal(embed.title, "🇺🇸 NA Lobby Status");
  assert.match(embed.description, /1\. B/);
});
