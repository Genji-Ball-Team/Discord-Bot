// Test helpers: an in-memory D1 (node:sqlite), and a fake Discord and site behind fetch.

import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

export function fakeD1() {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => db.prepare(sql).run(...args),
  });
  return { prepare: (sql) => stmt(sql), batch: async (list) => Promise.all(list.map((s) => s.run())), raw: db };
}

export const ENV = {
  DISCORD_APPLICATION_ID: "app1",
  DISCORD_TOKEN: "bot-token",
  STAFF_ROLE_ID: "staff-role",
  SITE_URL: "https://genjiball.us",
  EU_ROLE_ID: "role-eu",
  NA_ROLE_ID: "role-na",
  EU_DEFAULT_TIME: "21:00",
  EU_TIMEZONE: "Europe/Moscow",
  NA_DEFAULT_TIME: "21:00",
  NA_TIMEZONE: "America/New_York",
  SIGNUP_EMOJI: "✅",
  REMINDER_MINUTES: "5",
};

/** 75+ fake players per region, best first. */
export function fakeLeaderboard(region, total = 80) {
  return Array.from({ length: total }, (_, i) => ({
    rank: i + 1,
    id: (region === "na" ? 1000 : 0) + i + 1,
    name: i === 0 ? (region === "eu" ? "Fealthy" : "NaKing") : i === 1 ? "Ipseity" : `Player${i + 1}`,
    rating: 2000 - i * 10,
    rounds: 100,
    wins: 30,
    tier: { label: "Grandmaster", color: [255, 140, 0], threshold: 1900 },
  }));
}

/**
 * Installs a fake fetch. Discord calls are recorded in `calls`; `reactors` is who reacted to each
 * message; `closedDms` users answer 403 to a DM.
 */
export function installFetch({ reactors = {}, closedDms = new Set(), boardTotal = 80 } = {}) {
  const calls = [];
  let nextId = 5000;
  const dmChannels = new Map();
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url ?? String(input));
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(init.body) : undefined;
    const reply = (data, status = 200) => new Response(data === null ? null : JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

    if (url.hostname === "genjiball.us") {
      calls.push({ site: true, method, path: url.pathname + url.search });
      const region = url.searchParams.get("region") ?? "eu";
      if (url.pathname === "/api/leaderboard") {
        const page = Number(url.searchParams.get("page") ?? 1);
        const all = fakeLeaderboard(region, boardTotal);
        const players = all.slice((page - 1) * 50, page * 50);
        return reply({ region, page, pageSize: 50, hasMore: all.length > page * 50, players });
      }
      if (url.pathname === "/api/players") {
        const q = url.searchParams.get("search").toLowerCase();
        const players = fakeLeaderboard("eu")
          .filter((p) => p.name.toLowerCase().includes(q))
          .map((p) => ({ id: p.id, name: p.name, rating: p.rating, tier: p.tier, matchedAlias: null }));
        return reply({ region, players });
      }
      let m = /^\/api\/players\/(\d+)$/.exec(url.pathname);
      if (m) {
        const id = Number(m[1]);
        if (id === 999) return reply({ error: "not_found" }, 404);
        return reply({
          region,
          player: {
            id,
            name: id === 1 ? "Fealthy" : `Player${id}`,
            aliases: id === 1 ? ["Fealthy", "OldName"] : [],
            regions: ["eu", "na"],
            rating: { rank: id, id, name: "Fealthy", rating: 2000, rounds: 120, wins: 48, tier: { label: "Grandmaster", color: [255, 140, 0], threshold: 1900 }, inactiveSince: null, nextTier: { label: "Ascendant", threshold: 2200 } },
          },
          matches: [],
        });
      }
      m = /^\/api\/players\/(\d+)\/history$/.exec(url.pathname);
      if (m) return reply({ region, peak: { rating: 2087 }, streak: 3, bestStreak: 9, form: { rounds: 20, wins: 8, averagePosition: 2.1 } });
      m = /^\/api\/players\/(\d+)\/stats$/.exec(url.pathname);
      if (m) return reply({ region, stats: { rounds: 120, kills: 300, deflects: 500, touches: 610, deflectRounds: 100, averagePosition: 2.4 } });
      return reply({ error: "not_found" }, 404);
    }

    if (url.hostname === "discord.com") {
      const path = url.pathname.replace("/api/v10", "");
      calls.push({ method, path, body, query: url.search });
      let m;
      if (method === "PATCH" && /^\/webhooks\/app1\/[^/]+\/messages\/@original$/.test(path)) {
        return reply({ id: "board-msg", channel_id: "chan1", ...body });
      }
      if (method === "POST" && (m = /^\/channels\/([^/]+)\/messages$/.exec(path))) {
        if (m[1].startsWith("dm-")) {
          const user = m[1].slice(3);
          if (closedDms.has(user)) return reply({ message: "Cannot send messages to this user", code: 50007 }, 403);
        }
        return reply({ id: String(nextId++), channel_id: m[1], ...body });
      }
      if (method === "PATCH" && /^\/channels\/[^/]+\/messages\/[^/]+$/.test(path)) return reply({ id: "x", ...body });
      if (method === "PUT" && /reactions\/.+\/@me$/.test(path)) return reply(null, 204);
      if (method === "GET" && (m = /^\/channels\/[^/]+\/messages\/([^/]+)\/reactions\/(.+)$/.exec(path))) {
        const users = reactors[m[1]] ?? [];
        const after = url.searchParams.get("after");
        const start = after ? users.findIndex((u) => u.id === after) + 1 : 0;
        return reply(users.slice(start, start + 100));
      }
      if (method === "POST" && path === "/users/@me/channels") {
        dmChannels.set(body.recipient_id, `dm-${body.recipient_id}`);
        return reply({ id: `dm-${body.recipient_id}` });
      }
      return reply({ message: "Unknown route " + method + " " + path }, 404);
    }
    throw new Error("Unexpected fetch " + url);
  };
  return calls;
}

/** A ctx whose waitUntil promises the test can await. */
/** A server member with the staff role. */
export const STAFF = { user: { id: "fealthy-id" }, roles: ["staff-role"], permissions: "0" };

export function fakeCtx() {
  const pending = [];
  return { waitUntil: (p) => pending.push(p), done: () => Promise.all(pending) };
}
