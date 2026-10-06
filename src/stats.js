// /stats: a player's numbers from the site, with name autocomplete.

import { REGIONS, regionOf, tierColor } from "./site.js";

/** Autocomplete: up to 25 matching players, "Name · 1834 Master". Discord wants an answer in 3 s. */
export async function autocompletePlayers(site, text, regionValue) {
  const query = (text ?? "").trim();
  if (query.length < 2) return [];
  const data = await site.search(query, regionValue ? regionOf(regionValue) : undefined).catch(() => null);
  return (data?.players ?? []).slice(0, 25).map((p) => {
    const rating = p.rating === null || p.rating === undefined ? "unrated" : `${Math.round(p.rating)}${p.tier ? ` ${p.tier.label}` : ""}`;
    const alias = p.matchedAlias ? ` (was ${p.matchedAlias})` : "";
    return { name: `${p.name}${alias} · ${rating}`.slice(0, 100), value: String(p.id) };
  });
}

/**
 * The player the option means: an id when they picked from the list, or else whatever they typed,
 * matched by name (an exact name first, as the site's search orders them).
 */
export async function resolvePlayer(site, value, region) {
  const text = String(value ?? "").trim();
  if (/^\d+$/.test(text)) return Number(text);
  if (text.length < 2) return null;
  const data = await site.search(text, region).catch(() => null);
  const players = data?.players ?? [];
  const exact = players.find((p) => p.name.toLowerCase() === text.toLowerCase());
  return (exact ?? players[0])?.id ?? null;
}

const pct = (part, whole) => (whole ? `${Math.round((part / whole) * 100)}%` : "—");
const num = (n) => (n === null || n === undefined ? "—" : Math.round(n).toLocaleString("en-US"));

export async function renderStats(site, playerValue, regionValue) {
  // With no region picked, use the one they have a rating in (EU first).
  const asked = regionValue ? regionOf(regionValue) : null;
  const id = await resolvePlayer(site, playerValue, asked ?? undefined);
  if (!id) return { content: `I couldn't find a player called **${String(playerValue).slice(0, 50)}**.` };

  let region = asked ?? "eu";
  let profile = await site.player(id, region);
  if (!profile) return { content: "That player isn't on the site." };
  if (!asked && !profile.player.rating && profile.player.regions?.length) {
    region = profile.player.regions[0];
    profile = await site.player(id, region);
  }
  const [history, stats] = await Promise.all([
    site.history(id, region).catch(() => null),
    site.stats(id, region).catch(() => null),
  ]);

  const p = profile.player;
  const r = p.rating;
  const s = stats?.stats;
  const info = REGIONS[region];
  const fields = [];

  if (r) {
    fields.push(
      { name: "Rating", value: `**${num(r.rating)}**${r.tier ? ` · ${r.tier.label}` : ""}`, inline: true },
      { name: "Rank", value: r.rank ? `#${r.rank}` : "Unranked", inline: true },
      {
        name: "Next tier",
        value: r.nextTier ? `${r.nextTier.label} in ${num(r.nextTier.threshold - r.rating)}` : "Top tier",
        inline: true,
      },
      { name: "Rounds", value: num(r.rounds), inline: true },
      { name: "Wins", value: `${num(r.wins)} (${pct(r.wins, r.rounds)})`, inline: true },
      { name: "Avg place", value: s?.averagePosition ? s.averagePosition.toFixed(2) : "—", inline: true },
    );
  } else {
    fields.push({ name: "Rating", value: `No rated rounds in ${info.label} yet.`, inline: false });
  }
  if (s && s.rounds) {
    const per = (n) => (s.deflectRounds ? (n / s.deflectRounds).toFixed(2) : "—");
    fields.push(
      { name: "Kills", value: `${num(s.kills)} (${(s.kills / s.rounds).toFixed(2)}/round)`, inline: true },
      { name: "Deflects", value: `${num(s.deflects)} (${per(s.deflects)}/round)`, inline: true },
      { name: "Touches", value: `${num(s.touches)} (${per(s.touches)}/round)`, inline: true },
    );
  }
  if (history) {
    fields.push(
      { name: "Peak", value: history.peak ? num(history.peak.rating) : "—", inline: true },
      { name: "Win streak", value: `${history.streak ?? 0} now · best ${history.bestStreak ?? 0}`, inline: true },
      {
        name: "Last 20 rounds",
        value: history.form?.rounds ? `${history.form.wins} wins · avg ${history.form.averagePosition?.toFixed(2) ?? "—"}` : "—",
        inline: true,
      },
    );
  }
  if (p.regions?.length > 1) {
    const other = p.regions.find((x) => x !== region);
    if (other) fields.push({ name: "​", value: `Also ranked in ${REGIONS[other]?.label ?? other}: \`/stats player:${p.name} region:${other}\``, inline: false });
  }

  const aliases = (p.aliases ?? []).filter((a) => a !== p.name).slice(0, 5);
  return {
    embeds: [
      {
        title: `${p.name} — ${info.label}`,
        url: site.playerUrl(p.id, region),
        description: aliases.length ? `Also known as ${aliases.map((a) => `\`${a}\``).join(", ")}` : undefined,
        color: tierColor(r?.tier),
        fields,
        footer: { text: r?.inactiveSince ? "Inactive · genjiball.us" : "genjiball.us" },
      },
    ],
    allowed_mentions: { parse: [] },
  };
}
