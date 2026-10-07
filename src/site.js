// Reading genjiball.us's public API. The bot never changes the site.

export const REGIONS = {
  eu: { id: "eu", label: "EU", flag: "🇪🇺" },
  na: { id: "na", label: "NA", flag: "🇺🇸" },
};

export function regionOf(value) {
  return value === "na" ? "na" : "eu";
}

export class SiteError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export class Site {
  constructor(env) {
    this.base = (env.SITE_URL ?? "https://genjiball.us").replace(/\/+$/, "");
    this.calls = 0;
  }

  async get(path, params = {}) {
    const url = new URL(this.base + path);
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    this.calls++;
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (res.status === 404) return null;
    if (!res.ok) throw new SiteError(res.status, `The site answered ${res.status} for ${path}`);
    return res.json();
  }

  /** Upcoming tourneys (scheduled and live) and the first page of past ones. */
  tourneys(region) {
    return this.get("/api/tourneys", { region });
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

  tourney(id) {
    return this.get(`/api/tourneys/${id}`);
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
