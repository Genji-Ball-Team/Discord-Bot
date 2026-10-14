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
  TOURNEY_CHANNEL_ID: "signups",
  EU_DEFAULT_TIME: "21:00",
  EU_TIMEZONE: "Europe/Berlin",
  NA_DEFAULT_TIME: "21:00",
  NA_TIMEZONE: "America/New_York",
  CONFIRM_MINUTES: "5",
  RESULTS_CHANNEL_ID: "results",
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

/** A tourney's sign-ups on the fake site: `{ name, discordUserId, signedUpAt, removed }`, first come first. */
function signupsOf(siteSignups, id) {
  if (!siteSignups.has(id)) siteSignups.set(id, []);
  return siteSignups.get(id);
}

/**
 * Installs a fake fetch. Discord and site calls are recorded in `calls`; `closedDms` users answer
 * 403 to a DM; `siteTourneys` is the site's tourneys by id, `siteSignups` their sign-ups by id.
 */
export function installFetch({
  closedDms = new Set(),
  boardTotal = 80,
  siteTourneys = new Map(),
  siteSignups = new Map(),
  siteDown = false,
  feed = { entries: [], details: new Map() },
} = {}) {
  const calls = [];
  let nextTourney = 41;
  let nextId = 5000;
  const dmChannels = new Map();
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url ?? String(input));
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(init.body) : undefined;
    const reply = (data, status = 200) => new Response(data === null ? null : JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

    if (url.hostname === "genjiball.us") {
      calls.push({ site: true, method, path: url.pathname + url.search, body, auth: init.headers?.Authorization });
      // The bot's sign-ups (genjiball-ranked src/tourney/botSignups.ts), on `siteSignups`.
      const bot = /^\/api\/bot\/tourneys\/(\d+)\/signups(?:\/(\d+|[a-z]\w*))?$/.exec(url.pathname);
      if (bot) {
        if (init.headers?.Authorization !== "Bearer site-token") return reply({ error: "unauthorized" }, 401);
        if (siteDown) return reply({ error: "internal" }, 500);
        const tourney = siteTourneys.get(Number(bot[1]));
        if (!tourney) return reply({ error: "not_found" }, 404);
        const list = signupsOf(siteSignups, tourney.id);
        const state = () => {
          const count = list.filter((s) => !s.removed).length;
          return { capacity: 10, signups: { open: tourney.status === "scheduled", count, full: count >= 10 } };
        };
        if (method === "GET") return reply({ status: tourney.status, ...state(), entries: list.filter((s) => !s.removed) });
        if (tourney.status !== "scheduled") return reply({ error: "closed" }, 409);
        if (method === "DELETE") {
          const i = list.findIndex((s) => s.discordUserId === bot[2] && !s.removed);
          const [gone] = i >= 0 ? list.splice(i, 1) : [];
          return reply({ removed: Boolean(gone), name: gone?.name ?? null, ...state() });
        }
        const results = body.signups.map(({ discordUserId, name }) => {
          const own = list.find((s) => s.discordUserId === discordUserId);
          const named = list.find((s) => s.name.toLowerCase() === name.toLowerCase());
          let status = "created";
          if (own) status = own.removed ? "removed" : "exists";
          else if (named?.removed) status = "removed";
          else if (named) status = named.discordUserId ? "name_taken" : "linked";
          if (status === "linked") named.discordUserId = discordUserId;
          if (status === "created") list.push({ name, discordUserId, signedUpAt: "2026-10-06T10:00:00Z" });
          const row = list.find((s) => s.discordUserId === discordUserId && !s.removed);
          return { discordUserId, status, signup: row ? { name: row.name, signedUpAt: row.signedUpAt } : null };
        });
        return reply({ results, ...state() }, 201);
      }
      if (url.pathname.startsWith("/api/admin/")) {
        if (init.headers?.Authorization !== "Bearer admin-token") return reply({ error: "unauthorized", message: "No admin token" }, 401);
        if (siteDown) return reply({ error: "internal", message: "Internal error" }, 500);
        if (method === "POST" && url.pathname === "/api/admin/tourneys") {
          const tourney = { id: nextTourney++, status: "scheduled", lobbies: [], ...body };
          siteTourneys.set(tourney.id, tourney);
          return reply({ tourney }, 201);
        }
        const t = /^\/api\/admin\/tourneys\/(\d+)$/.exec(url.pathname);
        if (method === "POST" && t) {
          const tourney = siteTourneys.get(Number(t[1]));
          if (!tourney) return reply({ error: "not_found" }, 404);
          Object.assign(tourney, body);
          return reply({ tourney });
        }
      }
      // The match feed: `feed.entries` are { seq, match } in change order; `feed.details` the full matches.
      if (url.pathname === "/api/matches") {
        const after = url.searchParams.get("after");
        const last = feed.entries.at(-1)?.seq ?? 0;
        if (after === "latest") return reply({ cursor: String(last), hasMore: false, matches: [] });
        const limit = Number(url.searchParams.get("limit") ?? 20);
        const next = feed.entries.filter((e) => e.seq > Number(after));
        const page = next.slice(0, limit);
        return reply({ cursor: String(page.at(-1)?.seq ?? after), hasMore: next.length > limit, matches: page.map((e) => e.match) });
      }
      const detail = /^\/api\/matches\/(\d+)$/.exec(url.pathname);
      if (detail) {
        const match = feed.details.get(Number(detail[1]));
        return match ? reply({ match }) : reply({ error: "not_found" }, 404);
      }
      if (url.pathname === "/api/tourneys") {
        if (siteDown) return reply({ error: "internal" }, 500);
        const mine = [...siteTourneys.values()]
          .filter((t) => t.region === (url.searchParams.get("region") ?? "eu"))
          .map((t) => ({ ...t, signups: { open: t.status === "scheduled", count: signupsOf(siteSignups, t.id).filter((s) => !s.removed).length } }));
        const upcoming = mine.filter((t) => t.status === "scheduled" || t.status === "live").sort((a, b) => a.startsAt.localeCompare(b.startsAt));
        const past = mine.filter((t) => t.status === "done" || t.status === "cancelled");
        return reply({ region: url.searchParams.get("region"), page: 1, upcoming, past });
      }
      const pub = /^\/api\/tourneys\/(\d+)$/.exec(url.pathname);
      if (pub) {
        if (siteDown) return reply({ error: "internal" }, 500);
        const tourney = siteTourneys.get(Number(pub[1]));
        return tourney ? reply({ tourney }) : reply({ error: "not_found" }, 404);
      }
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
      if (method === "DELETE" && /^\/channels\/[^/]+\/messages\/[^/]+$/.test(path)) return reply(null, 204);
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
