// Reading genjiball.us's public API (docs/api.md in genjiball-ranked, "Site").

export const REGIONS = {
  eu: { id: "eu", label: "EU", flag: "🇪🇺" },
  na: { id: "na", label: "NA", flag: "🇺🇸" },
};

export function regionOf(value) {
  return value === "na" ? "na" : "eu";
}

export class Site {
  constructor(env) {
    this.base = (env.SITE_URL ?? "https://genjiball.us").replace(/\/+$/, "");
    this.calls = 0; // requests made, for the cron's budget
  }

  async get(path, params = {}) {
    const url = new URL(this.base + path);
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    this.calls++;
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`The site answered ${res.status} for ${path}`);
    return res.json();
  }

  /** The leaderboard's API pages hold 50 players each. */
  leaderboardPage(region, page) {
    return this.get("/api/leaderboard", { region, page });
  }

  search(text, region) {
    return this.get("/api/players", { search: text, region });
  }

  player(id, region) {
    return this.get(`/api/players/${id}`, { region });
  }

  history(id, region) {
    return this.get(`/api/players/${id}/history`, { region });
  }

  stats(id, region) {
    return this.get(`/api/players/${id}/stats`, { region });
  }

  /** Upcoming tourneys and the first page of past ones. */
  tourneys(region) {
    return this.get("/api/tourneys", { region });
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
}

/** The tier colours from genjiball-ranked src/config.ts, for embed colours. */
export function tierColor(tier) {
  if (!tier?.color) return 0x5865f2;
  const [r, g, b] = tier.color;
  return (r << 16) | (g << 8) | b;
}
