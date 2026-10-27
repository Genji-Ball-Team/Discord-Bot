// Reading genjiball.us's public API. With SITE_TOKEN (the site's BOT_TOKEN), the bot also signs
// players up for tourneys there (`/api/bot/...`): the only thing it changes on the site.

import { setting } from "./time.js";

export const REGIONS = {
  eu: { id: "eu", label: "EU", flag: "🇪🇺" },
  na: { id: "na", label: "NA", flag: "🇺🇸" },
};

/** Whether tourney sign-ups go to the site: SITE_TOKEN is set. Without it the bot keeps its own list. */
export const signsUp = (env) => setting(env, "SITE_TOKEN") !== "";

/** The region's label and flag; EU for anything else. */
export const regionInfo = (region) => REGIONS[region] ?? REGIONS.eu;

export function regionOf(value) {
  return value === "na" ? "na" : "eu";
}

class SiteError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * The site's public answers, kept for a minute (the site's own cache time), so a name typed letter by
 * letter or a player asked about again costs genjiball.us's D1 one read. Kept in this isolate, and in
 * Cloudflare's cache where the Worker has one, so another isolate in the same place finds it too.
 */
const CACHE_SECONDS = 60;
const MEMORY_ENTRIES = 500;
const memory = new Map();

/** Empties this isolate's cache: for the tests, whose fake site changes between them. */
export const clearSiteCache = () => memory.clear();

async function cached(url) {
  const hit = memory.get(url);
  if (hit && hit.until > Date.now()) return hit;
  try {
    const res = await globalThis.caches?.default?.match(url);
    if (res) return { data: await res.json() };
  } catch {
    // No cache here: ask the site.
  }
  return null;
}

async function keep(url, data) {
  if (memory.size >= MEMORY_ENTRIES) memory.delete(memory.keys().next().value);
  memory.set(url, { data, until: Date.now() + CACHE_SECONDS * 1000 });
  try {
    const headers = { "Content-Type": "application/json", "Cache-Control": `max-age=${CACHE_SECONDS}` };
    await globalThis.caches?.default?.put(url, new Response(JSON.stringify(data), { headers }));
  } catch {
    // Only the isolate's copy, then.
  }
}

/** SITE_TIMEOUT_SECONDS: how long a site request may take before it counts as the site failing. */
export const siteTimeoutMs = (env) => Math.min(30, Math.max(1, Number(env.SITE_TIMEOUT_SECONDS) || 5)) * 1000;

/** Autocomplete has to answer Discord within 3 seconds, the site's answer included. */
export const AUTOCOMPLETE_TIMEOUT_MS = 2000;

export class Site {
  /** `timeoutMs`: the limit for each request, SITE_TIMEOUT_SECONDS if left out. */
  constructor(env, { timeoutMs = siteTimeoutMs(env) } = {}) {
    this.base = (env.SITE_URL ?? "https://genjiball.us").replace(/\/+$/, "");
    this.token = setting(env, "SITE_TOKEN");
    this.timeoutMs = timeoutMs;
    this.calls = 0;
  }

  /** A slow site is a failing one: the callers' error paths handle it. */
  async request(url, init, what) {
    this.calls++;
    try {
      return await fetch(url, { ...init, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (e) {
      if (e?.name === "TimeoutError") throw new SiteError(0, `The site didn't answer ${what} within ${this.timeoutMs / 1000} s`);
      throw e;
    }
  }

  /** A call to the bot's routes. A 404 or 409 is an answer (`{ status, error }`), not an error. */
  async bot(method, path, body) {
    const headers = { Accept: "application/json", Authorization: `Bearer ${this.token}` };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const init = { method, headers, body: body === undefined ? undefined : JSON.stringify(body) };
    const res = await this.request(this.base + "/api/bot" + path, init, `for ${method} /api/bot${path}`);
    const data = await res.json().catch(() => null);
    if (res.ok || res.status === 404 || res.status === 409) return { status: res.status, ...data };
    throw new SiteError(res.status, `The site answered ${res.status} for ${method} /api/bot${path}`);
  }

  /** The tourney's sign-ups, with their Discord users: `{ signups, entries }`. */
  signups(id) {
    return this.bot("GET", `/tourneys/${id}/signups`);
  }

  /** Signs Discord users up: `list` is `[{ discordUserId, name }]`, at most 50. */
  signUp(id, list) {
    return this.bot("POST", `/tourneys/${id}/signups`, { signups: list });
  }

  unregister(id, userId) {
    return this.bot("DELETE", `/tourneys/${id}/signups/${userId}`);
  }

  /** `cache`: the answer may be up to a minute old (players and the leaderboard, not tourneys or the feed). */
  async get(path, params = {}, { cache = false } = {}) {
    const url = new URL(this.base + path);
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    const key = url.toString();
    if (cache) {
      const hit = await cached(key);
      if (hit) return hit.data;
    }
    const res = await this.request(url, { headers: { Accept: "application/json" } }, `for ${path}`);
    if (res.status !== 404 && !res.ok) throw new SiteError(res.status, `The site answered ${res.status} for ${path}`);
    const data = res.status === 404 ? null : await res.json();
    if (cache) await keep(key, data);
    return data;
  }

  /** Upcoming tourneys (scheduled and live) and the first page of past ones. */
  tourneys(region) {
    return this.get("/api/tourneys", { region });
  }

  /** The leaderboard's API pages hold 50 players each. */
  leaderboardPage(region, page) {
    return this.get("/api/leaderboard", { region, page }, { cache: true });
  }

  /** Each player's rating and tier in every region, for the rank roles: at most 200 ids. */
  tiers(ids) {
    return this.get("/api/tiers", { players: ids.join(",") });
  }

  /** The region's God and Demigod, with their rating and real place on the leaderboard. */
  titles(region) {
    return this.get("/api/titles", { region }, { cache: true });
  }

  /** Lowercased: "Fealthy" and "fealthy" are one search, and one cache entry. */
  search(text, region) {
    text = text.toLowerCase();
    return this.get("/api/players", { search: text, region }, { cache: true });
  }

  player(id, region) {
    return this.get(`/api/players/${id}`, { region }, { cache: true });
  }

  history(id, region) {
    return this.get(`/api/players/${id}/history`, { region }, { cache: true });
  }

  stats(id, region) {
    return this.get(`/api/players/${id}/stats`, { region }, { cache: true });
  }

  tourney(id) {
    return this.get(`/api/tourneys/${id}`);
  }

  /** The region's ranked lobbies open now (the host tool's heartbeats). Never cached: it's the live status. */
  lobbies(region) {
    return this.get("/api/lobbies", { region });
  }

  playerUrl(id, region) {
    return `${this.base}/player?id=${id}&region=${region}`;
  }

  tourneyUrl(id) {
    return `${this.base}/tourney?id=${id}`;
  }

  leaderboardUrl(region) {
    return `${this.base}/?region=${region}`;
  }

  liveUrl(region) {
    return `${this.base}/live?region=${region}`;
  }
}

/**
 * The tier to show: the site's `siteTier`, which has Rookie (on the site and here, not in game),
 * else `tier` (a site from before Rookie).
 */
export const shownTier = (rating) => rating?.siteTier ?? rating?.tier ?? null;

/** A tier's colour as Discord's embed colour number. */
export function tierColor(tier) {
  if (!tier?.color) return 0x5865f2;
  const [r, g, b] = tier.color;
  return (r << 16) | (g << 8) | b;
}

/** Discord markdown can't break out of a name. */
export function escapeMarkdown(text) {
  return String(text).replace(/([\\*_~`|>#[\]()-])/g, "\\$1");
}
