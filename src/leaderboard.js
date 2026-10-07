// /leaderboard: the top 75 of a region, 15 a page, with EU/NA and page buttons.

import { REGIONS, regionOf, tierColor } from "./site.js";

export const PAGE_SIZE = 15;
export const MAX_PAGES = 5;
const API_PAGE_SIZE = 50;

/** The players ranked `from`..`to` (1-based, inclusive), reading only the API pages needed. */
export async function fetchRanks(site, region, from, to) {
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

function pad(text, width) {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

export function formatLines(players) {
  const nameWidth = Math.min(18, Math.max(4, ...players.map((p) => p.name.length)));
  return players.map((p) => {
    const rank = pad(`${p.rank}.`, 4);
    const name = p.name.length > nameWidth ? p.name.slice(0, nameWidth - 1) + "…" : pad(p.name, nameWidth);
    return `${rank}${name} ${Math.round(p.rating)}`;
  });
}

/**
 * The whole message: an embed and the buttons. `page` is 1..5. A `live` board is the one kept up to
 * date in a channel: its buttons open a private copy for whoever presses them.
 */
export async function renderLeaderboard(site, regionValue, pageValue, { live = false, refreshMinutes = 5 } = {}) {
  const region = regionOf(regionValue);
  const page = Math.min(MAX_PAGES, Math.max(1, Number(pageValue) || 1));
  const from = (page - 1) * PAGE_SIZE + 1;
  const to = page * PAGE_SIZE;
  const { players, more } = await fetchRanks(site, region, from, to);
  const info = REGIONS[region];

  const description = players.length
    ? "```\n" + formatLines(players).join("\n") + "\n```"
    : page === 1
      ? "Nobody is ranked here yet."
      : "No players on this page yet.";

  const embed = {
    title: `${info.flag} ${info.label} Leaderboard — Top ${to}`,
    url: site.leaderboardUrl(region),
    description,
    color: tierColor(players[0]?.tier),
    footer: {
      text: live
        ? `Live · updates every ${refreshMinutes} min · the buttons show you your own copy · Updated`
        : `Page ${page}/${MAX_PAGES} · Updated`,
    },
    timestamp: new Date().toISOString(),
  };

  const canNext = page < MAX_PAGES && more;
  const components = [
    {
      type: 1,
      components: [
        button("EU", `lb:r:eu:1`, region === "eu" ? 1 : 2, region === "eu"),
        button("NA", `lb:r:na:1`, region === "na" ? 1 : 2, region === "na"),
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

/**
 * "lb:n:na:3" → { region: "na", page: 3 }, or null for another button. The second part only keeps
 * the ids apart (Discord wants each button's id unique): r region, p prev, x refresh, n next.
 */
export function parseButton(customId) {
  const m = /^lb:[rpxn]:(eu|na):(\d+)$/.exec(customId ?? "");
  return m ? { region: m[1], page: Number(m[2]) } : null;
}
