// The site's tourneys in Discord. genjiball.us runs the tourneys and their sign-ups; the bot
// announces each upcoming one in TOURNEY_CHANNEL_ID with its region's role pinged, keeps the post's
// sign-up count and status up to date, posts the standings when it's done, and DMs whoever pressed
// "Remind me" a few minutes before the start.

import { DiscordError, NO_PINGS } from "./discord.js";
import { escapeMarkdown } from "./leaderboard.js";
import { REGIONS } from "./site.js";

const reminderMinutes = (env) => Math.max(1, Number(env.REMINDER_MINUTES) || 5);
const channelOf = (env) => (env.TOURNEY_CHANNEL_ID ?? "").trim();
const roleOf = (env, region) => (env[`${region.toUpperCase()}_ROLE_ID`] ?? "").trim();
const colorOf = (region) => (region === "na" ? 0xb22234 : 0x003399);

/** Discord shows <t:…> in each reader's own time zone. */
export const discordTime = (ms, style = "F") => `<t:${Math.floor(ms / 1000)}:${style}>`;

function statusLine(env, t, url) {
  switch (t.status) {
    case "scheduled":
      return `**Sign up on [genjiball.us](${url})** with your in-game name. Press 🔔 **Remind me** for a DM ${reminderMinutes(env)} minutes before it starts.`;
    case "live":
      return "🔴 **Live now.** Sign-ups are closed.";
    case "done":
      return `🏁 **Finished.** The standings are on [the tourney page](${url}).`;
    default:
      return "❌ **This tourney was cancelled.**";
  }
}

/** The announcement: when, where to sign up, how many have, and the buttons. */
export function announcement(env, site, t) {
  const url = site.tourneyUrl(t.id);
  const start = Date.parse(t.startsAt);
  const lines = [`🕘 **${discordTime(start, "F")}** (${discordTime(start, "R")})`, "*That's shown in your own time zone.*"];
  if (t.notes) lines.push("", t.notes.length > 1000 ? t.notes.slice(0, 999) + "…" : t.notes);
  lines.push("", statusLine(env, t, url));

  const count = t.signups?.count ?? 0;
  const info = REGIONS[t.region] ?? REGIONS.eu;
  const fields = [
    { name: "Region", value: `${info.flag} ${info.label}`, inline: true },
    {
      name: "Signed up",
      value: t.capacity > 0 ? `**${count}** / ${t.capacity}${t.signups?.full ? " (full)" : ""}` : `**${count}**`,
      inline: true,
    },
  ];
  if (t.lobbies?.length) fields.push({ name: "Lobbies", value: String(t.lobbies.length), inline: true });

  const cancelled = t.status === "cancelled";
  const name = t.name.slice(0, 200);
  const buttons = [{ type: 2, style: 5, label: t.signups?.open ? "Sign up" : "Tourney page", url }];
  if (t.status === "scheduled") buttons.push({ type: 2, style: 2, label: "Remind me", emoji: { name: "🔔" }, custom_id: `tr:${t.id}` });
  return {
    embeds: [
      {
        title: cancelled ? `~~🏆 ${name}~~ — Cancelled` : `🏆 ${name}`,
        url,
        description: lines.join("\n"),
        color: cancelled ? 0x808080 : colorOf(t.region),
        fields,
        footer: { text: `Tourney #${t.id} on genjiball.us` },
      },
    ],
    components: [{ type: 1, components: buttons }],
    allowed_mentions: NO_PINGS,
  };
}

const MEDALS = ["🥇", "🥈", "🥉"];

/** A done tourney's standings, one field per lobby, or null while there are none to show. */
export function resultsMessage(site, t) {
  if (t.status !== "done") return null;
  const lobbies = (t.lobbies ?? []).filter((l) => !l.void && l.standings?.length);
  if (!lobbies.length) return null;
  const fields = lobbies.slice(0, 25).map((l) => {
    const lines = l.standings.map((s) => {
      const place = MEDALS[s.place - 1] ?? `\`${s.place}.\``;
      return `${place} **${escapeMarkdown(s.name)}** — ${s.wins} ${s.wins === 1 ? "win" : "wins"} · ${s.kills} ${s.kills === 1 ? "kill" : "kills"}`;
    });
    let value = "";
    for (const line of lines) {
      if (value.length + line.length + 1 > 1024) break;
      value += (value ? "\n" : "") + line;
    }
    return { name: `${l.label}${l.verified ? " · ✅ verified" : ""}`.slice(0, 256), value };
  });
  return {
    embeds: [
      {
        title: `🏁 ${t.name.slice(0, 200)}: standings`,
        url: site.tourneyUrl(t.id),
        color: colorOf(t.region),
        fields,
        footer: { text: "Most rounds won first, ties broken by kills. ✅: checked by an admin against the final screenshot." },
      },
    ],
    allowed_mentions: NO_PINGS,
  };
}

/** Discord answered "no access" or "gone": log it, leave the post as it is. */
const lostAccess = (e) => e instanceof DiscordError && (e.status === 403 || e.status === 404);

async function syncOne(env, discord, site, channelId, t, row, budget) {
  const post = announcement(env, site, t);
  const shown = JSON.stringify(post);
  const startsAt = Math.floor(Date.parse(t.startsAt) / 1000);

  if (!row) {
    if (t.status !== "scheduled" && t.status !== "live") return;
    // Only an announcement with sign-ups still open pings the region.
    const role = t.status === "scheduled" ? roleOf(env, t.region) : "";
    let message;
    try {
      message = await discord.sendMessage(channelId, {
        ...post,
        content: role ? `<@&${role}>` : undefined,
        allowed_mentions: role ? { parse: [], roles: [role] } : NO_PINGS,
      });
    } catch (e) {
      if (!lostAccess(e)) throw e;
      console.error(`can't post tourney ${t.id} in ${channelId}`, e);
      return;
    }
    await env.DB.prepare(
      `INSERT INTO tourneys (id, region, name, starts_at, status, channel_id, message_id, shown) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(t.id, t.region, t.name, startsAt, t.status, channelId, message.id, shown)
      .run();
    return;
  }

  if (row.shown !== shown) {
    // A deleted post (or lost access) isn't retried: the new state is recorded all the same.
    await discord.editMessage(row.channel_id, row.message_id, post).catch((e) => {
      if (!lostAccess(e)) throw e;
    });
    await env.DB.prepare("UPDATE tourneys SET name = ?, starts_at = ?, status = ?, shown = ? WHERE id = ?")
      .bind(t.name, startsAt, t.status, shown, t.id)
      .run();
  }

  const results = resultsMessage(site, t);
  if (!results || budget() < 2) return;
  const resultsShown = JSON.stringify(results);
  if (row.results_shown === resultsShown) return;
  let id = row.results_message_id;
  try {
    if (id) await discord.editMessage(row.channel_id, id, results);
    else id = (await discord.sendMessage(row.channel_id, { ...results, message_reference: { message_id: row.message_id, fail_if_not_exists: false } })).id;
  } catch (e) {
    if (!lostAccess(e)) throw e;
  }
  await env.DB.prepare("UPDATE tourneys SET results_message_id = ?, results_shown = ? WHERE id = ?").bind(id, resultsShown, t.id).run();
}

/**
 * Reads each region's tourneys and brings the posts up to date: announces new upcoming ones, edits
 * the ones that changed (count, time, status), posts the standings of finished ones. Posts are only
 * touched on a change, and it stops when the run's budget is low; the next refresh carries on.
 */
export async function syncTourneys(env, discord, site, budget) {
  const channelId = channelOf(env);
  if (!channelId) return;
  for (const region of Object.keys(REGIONS)) {
    if (budget() < 3) return;
    const data = await site.tourneys(region);
    if (!data) continue;
    const known = new Map(
      (await env.DB.prepare("SELECT * FROM tourneys WHERE region = ?").bind(region).all()).results.map((r) => [r.id, r]),
    );
    // Past tourneys only matter if they were announced: their post shows the end and the standings.
    for (const t of [...(data.upcoming ?? []), ...(data.past ?? []).filter((p) => known.has(p.id))]) {
      if (budget() < 2) return;
      await syncOne(env, discord, site, channelId, t, known.get(t.id), budget);
    }
  }
}

/** The 🔔 Remind me button: turns the presser's DM on or off. Answers privately. */
export async function toggleReminder(env, site, interaction, tourneyId, nowMs = Date.now()) {
  const userId = interaction.member?.user?.id ?? interaction.user?.id;
  const t = await env.DB.prepare("SELECT * FROM tourneys WHERE id = ?").bind(tourneyId).first();
  if (!t) return "I don't know that tourney.";
  const name = `**${escapeMarkdown(t.name)}**`;
  if (t.status === "cancelled") return `${name} was cancelled.`;
  if (t.status !== "scheduled" || t.starts_at * 1000 <= nowMs) return `${name} has already started.`;
  if (t.reminded) return `The reminders for ${name} already went out: it starts ${discordTime(t.starts_at * 1000, "R")}.`;

  const removed = await env.DB.prepare("DELETE FROM reminders WHERE tourney_id = ? AND user_id = ?").bind(t.id, userId).run();
  if (removed.changes) return `🔕 OK, no DM for ${name}.`;
  await env.DB.prepare("INSERT INTO reminders (tourney_id, user_id, channel_id) VALUES (?, ?, ?)")
    .bind(t.id, userId, interaction.channel_id ?? interaction.channel?.id ?? t.channel_id)
    .run();
  return (
    `🔔 I'll DM you ${reminderMinutes(env)} minutes before ${name} starts (${discordTime(t.starts_at * 1000, "F")}). Press again to cancel.\n` +
    `This doesn't sign you up: do that on [genjiball.us](${site.tourneyUrl(t.id)}).`
  );
}

async function dmChannel(env, discord, userId) {
  const known = await env.DB.prepare("SELECT channel_id FROM dm_channels WHERE user_id = ?").bind(userId).first();
  if (known) return known.channel_id;
  const channel = await discord.openDm(userId);
  await env.DB.prepare("INSERT OR REPLACE INTO dm_channels (user_id, channel_id) VALUES (?, ?)").bind(userId, channel.id).run();
  return channel.id;
}

/** Sends one tourney's waiting DMs, as many as the budget allows. Returns when it's all done. */
async function remindOne(env, discord, site, t, nowMs, budget) {
  const info = REGIONS[t.region] ?? REGIONS.eu;
  const start = t.starts_at * 1000;
  // Cancelled, over, or long started: nobody needs the DM any more.
  const tooLate = t.status === "cancelled" || t.status === "done" || nowMs > start + 30 * 60_000;
  const pending = tooLate
    ? []
    : (
        await env.DB.prepare("SELECT user_id FROM reminders WHERE tourney_id = ? AND dm_status = 'pending' LIMIT 50")
          .bind(t.id)
          .all()
      ).results;

  for (const { user_id } of pending) {
    if (budget() < 4) return; // the next cron run carries on
    let status = "sent";
    try {
      const channelId = await dmChannel(env, discord, user_id);
      await discord.sendMessage(channelId, {
        content:
          `⏰ **${escapeMarkdown(t.name)}** (${info.flag} ${info.label}) starts ${discordTime(start, "R")}, at ${discordTime(start, "t")}.\n` +
          `The lobbies are on ${site.tourneyUrl(t.id)}. Good luck!`,
        allowed_mentions: NO_PINGS,
      });
    } catch (e) {
      // 403: their DMs are closed. 404: the account is gone. Either way, no retry.
      if (!lostAccess(e)) throw e;
      status = "failed";
    }
    await env.DB.prepare("UPDATE reminders SET dm_status = ? WHERE tourney_id = ? AND user_id = ?").bind(status, t.id, user_id).run();
  }

  if (!tooLate) {
    const left = await env.DB.prepare("SELECT 1 FROM reminders WHERE tourney_id = ? AND dm_status = 'pending' LIMIT 1").bind(t.id).first();
    if (left) return;
  }

  // All sent (or too late to bother): name who couldn't be reached where they pressed, and finish.
  const failed = (
    await env.DB.prepare("SELECT user_id, channel_id FROM reminders WHERE tourney_id = ? AND dm_status = 'failed'").bind(t.id).all()
  ).results;
  if (failed.length && !tooLate) {
    const byChannel = Map.groupBy(failed, (f) => f.channel_id);
    for (const [channelId, users] of byChannel) {
      if (budget() < 2) break;
      const ids = users.slice(0, 50).map((u) => u.user_id);
      await discord
        .sendMessage(channelId, {
          content: `Couldn't DM ${ids.map((id) => `<@${id}>`).join(", ")} (DMs closed): ${escapeMarkdown(t.name)} starts ${discordTime(start, "R")}!`,
          allowed_mentions: { parse: [], users: ids },
        })
        .catch(() => null);
    }
  }
  await env.DB.prepare("UPDATE tourneys SET reminded = 1 WHERE id = ?").bind(t.id).run();
}

/** The cron's reminder work, every minute: DM whoever asked, for tourneys starting soon. */
export async function sendReminders(env, discord, site, budget, nowMs = Date.now()) {
  const due = Math.floor(nowMs / 1000) + reminderMinutes(env) * 60;
  const { results } = await env.DB.prepare("SELECT * FROM tourneys WHERE reminded = 0 AND starts_at <= ? ORDER BY starts_at LIMIT 5")
    .bind(due)
    .all();
  for (const t of results) {
    if (budget() < 4) return;
    await remindOne(env, discord, site, t, nowMs, budget);
  }
}
