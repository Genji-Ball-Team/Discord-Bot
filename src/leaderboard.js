// The leaderboard message: 15 players a page, up to page 5 (top 75), EU and NA tabs.

import { REGIONS, escapeMarkdown, regionOf } from "./site.js";

export const PAGE_SIZE = 15;
export const MAX_PAGES = 5;
const API_PAGE_SIZE = 50;

/** Players ranked `from`..`to`, and whether anyone is ranked after `to`. */
async function fetchRanks(site, region, from, to) {
  const first = Math.ceil(from / API_PAGE_SIZE);
  const last = Math.ceil(to / API_PAGE_SIZE);
  const players = [];
  let hasMore = false;
  for (let page = first; page <= last; page++) {
    const data = await site.leaderboardPage(region, page);
    players.push(...(data?.players ?? []));
    hasMore = Boolean(data?.hasMore);
    if (!data?.hasMore) break;
  }
  const inRange = players.filter((p) => p.rank >= from && p.rank <= to);
  const more = hasMore || players.some((p) => p.rank > to);
  return { players: inRange, more };
}

function formatLines(players) {
  const width = String(Math.max(...players.map((p) => p.rank))).length + 1;
  return players.map((p) => {
    const place = "`" + `${p.rank}.`.padStart(width, " ") + "`";
    const name = p.name.length > 20 ? p.name.slice(0, 19) + "…" : p.name;
    return `${place} **${escapeMarkdown(name)}** — ${p.tier?.label ?? "Unranked"} · **${Math.round(p.rating)} Elo**`;
  });
}

export async function renderLeaderboard(site, regionValue, pageValue, { live = false, refreshMinutes = 5 } = {}) {
  const region = regionOf(regionValue);
  const page = Math.min(MAX_PAGES, Math.max(1, Number(pageValue) || 1));
  const from = (page - 1) * PAGE_SIZE + 1;
  const to = page * PAGE_SIZE;
  const { players, more } = await fetchRanks(site, region, from, to);
  const info = REGIONS[region];
  const description = players.length
    ? formatLines(players).join("\n")
    : page === 1
      ? "Nobody is ranked here yet."
      : "No players on this page yet.";
  const embed = {
    title: `${info.label} Leaderboard — Top ${to}`,
    url: site.leaderboardUrl(region),
    description,
    color: 0xed4245,
    footer: {
      text: live ? `Live · updates every ${refreshMinutes} min · the buttons show you your own copy · Updated` : `Page ${page}/${MAX_PAGES} · Updated`,
    },
    timestamp: new Date().toISOString(),
  };
  const canNext = page < MAX_PAGES && more;
  const components = [
    {
      type: 1,
      components: [
        button("EU", "lb:r:eu:1", region === "eu" ? 1 : 2, region === "eu"),
        button("NA", "lb:r:na:1", region === "na" ? 1 : 2, region === "na"),
      ],
    },
    {
      type: 1,
      components: [
        button("◀ Prev", `lb:p:${region}:${page - 1}`, 2, page <= 1),
        button(`${page} / ${MAX_PAGES}`, `lb:x:${region}:${page}`, 2, false),
        button("Next ▶", `lb:n:${region}:${page + 1}`, 2, !canNext),
      ],
    },
  ];
  return { region, page, message: { embeds: [embed], components, allowed_mentions: { parse: [] } } };
}

function button(label, customId, style, disabled) {
  return { type: 2, style, label, custom_id: customId, disabled };
}

/** A leaderboard button's target, or null for another button. */
export function parseButton(customId) {
  const m = /^lb:[rpxn]:(eu|na):(\d+)$/.exec(customId ?? "");
  return m ? { region: m[1], page: Number(m[2]) } : null;
}
