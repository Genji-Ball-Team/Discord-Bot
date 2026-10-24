// The leaderboard message: the top 20, EU and NA tabs and a link to the whole leaderboard on the site
// (/gr leaderboard's page option shows the next 20s, up to page 5). Each player's rank is a mention of
// its role, which Discord colours and which pings nobody; the region's God and Demigod (the 1v1
// tourney's titles, src/ranks.js) stay in their place, shown with their title's role instead.

import { NO_PINGS, EMBED_COLOR } from "./discord.js";
import { REGIONS, escapeMarkdown, regionOf, shownTier } from "./site.js";

const PAGE_SIZE = 20;
const MAX_PAGES = 5;
const API_PAGE_SIZE = 50;

/** Players ranked `from`..`to`. */
async function fetchRanks(site, region, from, to) {
  const first = Math.ceil(from / API_PAGE_SIZE);
  const last = Math.ceil(to / API_PAGE_SIZE);
  const players = [];
  for (let page = first; page <= last; page++) {
    const data = await site.leaderboardPage(region, page);
    players.push(...(data?.players ?? []));
    if (!data?.hasMore) break;
  }
  return players.filter((p) => p.rank >= from && p.rank <= to);
}

/** A rank or title as its role's mention (`roles`: label → role id), or its name without one. */
const shownRank = (label, roles) => (roles.get(label) ? `<@&${roles.get(label)}>` : label);

function formatLines(players, titles, roles) {
  const width = String(Math.max(...players.map((p) => p.rank))).length + 1;
  return players.map((p) => {
    const place = "`" + `${p.rank}.`.padStart(width, " ") + "`";
    const name = p.name.length > 20 ? p.name.slice(0, 19) + "…" : p.name;
    const rank = titles.get(p.id) ?? shownTier(p)?.label ?? "Unranked";
    return `${place} **${escapeMarkdown(name)}** — ${shownRank(rank, roles)} · **${Math.round(p.rating)} Elo**`;
  });
}

/**
 * `roles`: the role shown for each rank and title, by label (src/ranks.js `leaderboardRoles`).
 * A label without one is written out.
 */
export async function renderLeaderboard(site, regionValue, pageValue, { live = false, refreshMinutes = 5, roles = new Map() } = {}) {
  const region = regionOf(regionValue);
  const page = Math.min(MAX_PAGES, Math.max(1, Number(pageValue) || 1));
  const from = (page - 1) * PAGE_SIZE + 1;
  const to = page * PAGE_SIZE;
  // No titles when the site can't say: everyone shows their rank.
  const titled = (await site.titles(region).catch(() => null))?.titles ?? [];
  const titles = new Map(titled.map((t) => [t.id, t.title]));
  const players = await fetchRanks(site, region, from, to);
  const info = REGIONS[region];
  const lines = players.length ? formatLines(players, titles, roles) : [page === 1 ? "Nobody is ranked here yet." : "No players on this page yet."];
  const description = lines.join("\n");
  const embed = {
    title: `🏆 ${info.label} Leaderboard — Top ${to}`,
    url: site.leaderboardUrl(region),
    description,
    color: EMBED_COLOR,
    footer: {
      text: live ? `Live · updates every ${refreshMinutes} min · the buttons show you your own copy · Updated` : `Page ${page}/${MAX_PAGES} · Updated`,
    },
    timestamp: new Date().toISOString(),
  };
  // EU and NA, and the whole leaderboard on the site: no pages to flip.
  const components = [
    {
      type: 1,
      components: [
        button("EU", "lb:r:eu:1", region === "eu" ? 1 : 2, region === "eu"),
        button("NA", "lb:r:na:1", region === "na" ? 1 : 2, region === "na"),
        { type: 2, style: 5, label: "Full leaderboard", url: site.leaderboardUrl(region) },
      ],
    },
  ];
  return { region, page, message: { embeds: [embed], components, allowed_mentions: NO_PINGS } };
}

function button(label, customId, style, disabled) {
  return { type: 2, style, label, custom_id: customId, disabled };
}

/** A leaderboard button's target, or null for another button. */
export function parseButton(customId) {
  const m = /^lb:[rpxn]:(eu|na):(\d+)$/.exec(customId ?? "");
  return m ? { region: m[1], page: Number(m[2]) } : null;
}
