// Tournaments. Admins make them on genjiball.us (the admin page), as before; the bot posts each
// one in TOURNEY_CHANNEL_ID and runs its sign-up in Discord:
//
// 1. `open`: the sign-up post has Register, Unregister and Who's signed up. No pings.
// 2. `confirming` (CONFIRM_MINUTES before the start): every registered player gets a DM with a
//    Confirm button. Anyone who doesn't press it before the start isn't playing. Register stays
//    open, and registering now confirms at once.
// 3. `started` (at the start): the sign-up post is deleted and the list of confirmed players is
//    posted in its channel as @mentions that notify nobody. Later, when an admin marks it done on
//    the site, the standings are posted under the list.
//
// A tourney renamed, moved or cancelled on the site is updated here on the next sync (every
// TOURNEY_REFRESH_MINUTES).
//
// One list with the site (SITE_TOKEN set): Register asks for the in-game name and signs the player
// up on the site too, Unregister takes them off it, and the post's count and Who's signed up are
// the site's, names typed on the tourney's page included. Registrations from before SITE_TOKEN are
// sent on the sync. Without SITE_TOKEN the bot keeps its own list, as before.

import { NO_PINGS, lostAccess } from "./discord.js";
import { REGIONS, escapeMarkdown, signsUp } from "./site.js";
import { discordTime } from "./time.js";

export const confirmMinutes = (env) => Math.max(1, Number(env.CONFIRM_MINUTES) || 5);
const signupChannel = (env) => (env.TOURNEY_CHANNEL_ID ?? "").trim();
// Red, like the leaderboard.
const colorOf = () => 0xed4245;
const MESSAGE_MAX = 2000;
/** How long after the start the bot still looks for the standings on the site. */
const RESULTS_WINDOW_SECONDS = 3 * 24 * 3600;

const userOf = (interaction) => interaction.member?.user ?? interaction.user;
const displayName = (interaction) => {
  const user = userOf(interaction);
  return (interaction.member?.nick || user?.global_name || user?.username || "player").slice(0, 64);
};

// ---- What the messages look like ----

function signupPost(env, t, counts) {
  const start = t.starts_at * 1000;
  const info = REGIONS[t.region] ?? REGIONS.eu;
  const confirming = t.phase === "confirming";
  const cancelled = t.phase === "cancelled";
  const lines = [`🕘 **${discordTime(start, "F")}** (${discordTime(start, "R")})`, "*That's shown in your own time zone.*", ""];
  if (cancelled) lines.push("❌ **This tournament was cancelled.**");
  else if (confirming) {
    lines.push(
      "Everyone who registered got a DM: press **Confirm** there to play. No confirm, no spot.",
      "Just arrived? Press **Register** now and you're confirmed straight away.",
    );
  } else lines.push(`Press **Register** to play. ${confirmMinutes(env)} minutes before the start I'll DM you to confirm.`);

  const fields = [{ name: "Region", value: `${info.flag} ${info.label}`, inline: true }];
  if (confirming) {
    fields.push(
      { name: "Registered", value: `**${counts.registered}**`, inline: true },
      { name: "Confirmed", value: `**${counts.confirmed}**`, inline: true },
    );
  } else if (!cancelled) fields.push({ name: "Signed up", value: `**${counts.registered}**`, inline: true });

  const buttons = [
    { type: 2, style: 3, label: "Register", custom_id: `gr:reg:${t.id}` },
    { type: 2, style: 2, label: "Unregister", custom_id: `gr:unreg:${t.id}` },
    { type: 2, style: 2, label: "Who's signed up", emoji: { name: "👥" }, custom_id: `gr:who:${t.id}` },
  ];
  const name = t.name.slice(0, 200);
  return {
    content: "",
    embeds: [
      {
        title: cancelled ? `~~🏆 ${name}~~ · Cancelled` : confirming ? `🏆 ${name} · confirming now` : `🏆 ${name}`,
        description: lines.join("\n"),
        color: cancelled ? 0x808080 : colorOf(t.region),
        fields,
        footer: {
          text: cancelled
            ? `Tournament #${t.id}`
            : confirming
              ? "Only confirmed players go on the list"
              : `Sign-ups close ${confirmMinutes(env)} minutes before the start · Tournament #${t.id}`,
        },
      },
    ],
    components: cancelled ? [] : [{ type: 1, components: buttons }],
    allowed_mentions: NO_PINGS,
  };
}

function confirmDm(env, t) {
  const info = REGIONS[t.region] ?? REGIONS.eu;
  return {
    content:
      `⏰ **Tournament starting in ${confirmMinutes(env)} minutes**\n` +
      `**${escapeMarkdown(t.name)}** (${info.flag} ${info.label}) starts at ${discordTime(t.starts_at * 1000, "t")}. ` +
      "Press **Confirm** to play. If you don't confirm, you aren't playing.",
    components: [{ type: 1, components: [{ type: 2, style: 3, label: "Confirm", custom_id: `gr:conf:${t.id}` }] }],
    allowed_mentions: NO_PINGS,
  };
}

/**
 * The final list, split into messages under Discord's 2,000 characters. `siteOnly`: names signed up
 * on the site's page with no Discord user, who couldn't confirm: listed apart for the hosts.
 */
export function listMessages(t, userIds, siteOnly = []) {
  const head = `📋 **${escapeMarkdown(t.name)}** · **${userIds.length} confirmed ${userIds.length === 1 ? "player" : "players"}**`;
  const tail = "Hosts: split the lobbies from this list.";
  if (!userIds.length && !siteOnly.length) return [`${head}\nNobody confirmed, so this tournament has no players.`];
  const lines = userIds.map((id, i) => `${i + 1}. <@${id}>`);
  if (siteOnly.length) lines.push("", "Also signed up on the site, not on Discord (they couldn't confirm):", ...siteOnly.map((n) => `- ${escapeMarkdown(n)}`));
  const messages = [];
  let current = head;
  lines.forEach((line) => {
    if (current.length + line.length + 1 > MESSAGE_MAX) {
      messages.push(current);
      current = line;
    } else current += "\n" + line;
  });
  if (current.length + tail.length + 2 > MESSAGE_MAX) {
    messages.push(current);
    current = tail;
  } else current += "\n\n" + tail;
  messages.push(current);
  return messages;
}

const MEDALS = ["🥇", "🥈", "🥉"];

/** The standings once an admin marks the tourney done on the site, or null. */
function resultsMessage(site, t) {
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

// ---- Database ----

/** What the post counts: the site's sign-ups when they're one list, else the bot's own. */
async function counts(env, t) {
  const row = await env.DB.prepare("SELECT COUNT(*) AS registered, COALESCE(SUM(confirmed), 0) AS confirmed FROM entrants WHERE tournament_id = ?")
    .bind(t.id)
    .first();
  const site = signsUp(env) ? t.signups : null;
  return { registered: site ?? row?.registered ?? 0, confirmed: row?.confirmed ?? 0 };
}

/** Keeps the site's sign-up count the post shows. */
async function setSiteCount(env, t, count) {
  if (typeof count !== "number" || count === t.signups) return false;
  await env.DB.prepare("UPDATE tournaments SET signups = ? WHERE id = ?").bind(count, t.id).run();
  t.signups = count;
  return true;
}

/** Re-renders the sign-up post. */
async function refreshPost(env, discord, t) {
  if (!t.message_id) return;
  await discord.editMessage(t.channel_id, t.message_id, signupPost(env, t, await counts(env, t))).catch((e) => {
    if (!lostAccess(e)) throw e;
  });
}

// ---- Following the site's tourneys ----

export const tourneyMinutes = (env) => Math.max(1, Number(env.TOURNEY_REFRESH_MINUTES) || 5);
const toUnix = (iso) => Math.floor(Date.parse(iso) / 1000);

/**
 * Posts the site's new tourneys, and brings the bot's up to date with the site: a new name or start
 * time, or a cancelled (or deleted) tourney. A tourney whose start has passed is never posted.
 */
export async function syncTourneys(env, discord, site, budget, nowMs = Date.now()) {
  const channelId = signupChannel(env);
  if (!channelId) return;
  const now = Math.floor(nowMs / 1000);
  for (const region of Object.keys(REGIONS)) {
    if (budget() < 4) return;
    const data = await site.tourneys(region);
    if (!data) continue;
    const upcoming = data.upcoming ?? [];
    const onSite = new Map([...(data.past ?? []), ...upcoming].map((t) => [t.id, t]));
    const { results } = await env.DB.prepare("SELECT * FROM tournaments WHERE region = ? AND starts_at > ?").bind(region, now - 30 * 24 * 3600).all();
    const known = new Map(results.map((r) => [r.id, r]));

    for (const st of upcoming) {
      if (known.has(st.id) || st.status !== "scheduled" || toUnix(st.startsAt) <= now) continue;
      if (budget() < 3) return;
      await postNew(env, discord, channelId, region, st, nowMs);
    }

    for (const t of results) {
      if (t.phase !== "open" && t.phase !== "confirming") continue;
      if (budget() < 3) return;
      let st = onSite.get(t.id);
      if (!st) {
        // Not in the lists: look it up. A site error leaves it alone; only a 404 (deleted) cancels.
        const found = await site.tourney(t.id).catch(() => undefined);
        if (found === undefined) continue;
        st = found?.tourney ?? null;
      }
      if (!st || st.status === "cancelled") await cancelHere(env, discord, t);
      else {
        if (st.name !== t.name || toUnix(st.startsAt) !== t.starts_at) await moveHere(env, discord, t, st, now);
        if (signsUp(env)) await followSignups(env, discord, site, t, st, budget);
      }
    }
  }
}

/**
 * One list with the site: sends it the registrations it doesn't have yet, and updates the post's
 * count when the site's changed (names typed on the tourney's page count too).
 */
async function followSignups(env, discord, site, t, st, budget) {
  const pushed = budget() >= 4 ? await pushEntrants(env, site, t) : null;
  const changed = await setSiteCount(env, t, pushed ?? st.signups?.count);
  if (changed && budget() >= 2) await refreshPost(env, discord, t);
}

/** A name as the site takes it: no control characters, at most 64 characters. */
const siteName = (name, fallback = "") =>
  [...String(name ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim()].slice(0, 64).join("").trim() || fallback;

/**
 * Sends the site the registrations it doesn't have (`on_site` 0): those from before SITE_TOKEN, under
 * the server name they registered with. Returns the site's count, or null.
 */
async function pushEntrants(env, site, t) {
  const { results } = await env.DB.prepare("SELECT user_id, name FROM entrants WHERE tournament_id = ? AND on_site = 0 ORDER BY registered_at, user_id LIMIT 50")
    .bind(t.id)
    .all();
  if (!results.length) return null;
  const answer = await site.signUp(t.id, results.map((r) => ({ discordUserId: r.user_id, name: siteName(r.name, `Discord ${r.user_id}`) })));
  // Closed or gone on the site: the sync and the start deal with that.
  if (!answer.results) return null;
  const ids = (...statuses) => JSON.stringify(answer.results.filter((r) => statuses.includes(r.status)).map((r) => r.discordUserId));
  const where = "WHERE tournament_id = ? AND user_id IN (SELECT value FROM json_each(?))";
  await env.DB.batch([
    env.DB.prepare(`UPDATE entrants SET on_site = 1 ${where}`).bind(t.id, ids("created", "linked", "exists")),
    // Another Discord user has the name: they stay registered here, off the site's list.
    env.DB.prepare(`UPDATE entrants SET on_site = 2 ${where}`).bind(t.id, ids("name_taken", "too_many")),
    // An admin removed them on the site.
    env.DB.prepare(`DELETE FROM entrants ${where}`).bind(t.id, ids("removed")),
  ]);
  return answer.signups?.count ?? null;
}

async function cancelHere(env, discord, t) {
  await env.DB.prepare("UPDATE tournaments SET phase = 'cancelled' WHERE id = ?").bind(t.id).run();
  t.phase = "cancelled";
  await refreshPost(env, discord, t);
}

/** A new name or start time from the site. */
async function moveHere(env, discord, t, st, now) {
  const startsAt = toUnix(st.startsAt);
  // Moved later, out of the confirm minutes: back to sign-ups, and the DMs go out again then.
  const reopen = t.phase === "confirming" && startsAt - now > confirmMinutes(env) * 60;
  const writes = [env.DB.prepare("UPDATE tournaments SET name = ?, starts_at = ?, phase = ? WHERE id = ?").bind(st.name, startsAt, reopen ? "open" : t.phase, t.id)];
  if (reopen) writes.push(env.DB.prepare("UPDATE entrants SET dm_status = 'none' WHERE tournament_id = ? AND confirmed = 0").bind(t.id));
  await env.DB.batch(writes);
  Object.assign(t, { name: st.name, starts_at: startsAt, phase: reopen ? "open" : t.phase });
  await refreshPost(env, discord, t);
}

async function postNew(env, discord, channelId, region, st, nowMs) {
  const signups = signsUp(env) ? (st.signups?.count ?? 0) : null;
  const t = { id: st.id, region, name: st.name, starts_at: toUnix(st.startsAt), channel_id: channelId, phase: "open", signups };
  let message;
  try {
    message = await discord.sendMessage(channelId, signupPost(env, t, { registered: signups ?? 0, confirmed: 0 }));
  } catch (e) {
    if (!lostAccess(e)) throw e;
    console.error(`can't post tourney ${t.id} in ${channelId}`, e);
    return;
  }
  await env.DB.prepare(
    `INSERT OR IGNORE INTO tournaments (id, region, name, starts_at, channel_id, message_id, phase, created_by, created_at, signups)
     VALUES (?, ?, ?, ?, ?, ?, 'open', 'site', ?, ?)`,
  )
    .bind(t.id, region, t.name, t.starts_at, channelId, message.id, Math.floor(nowMs / 1000), signups)
    .run();
}

// ---- Buttons ----

/** A tournament button (`gr:<action>:<id>`), or the in-game name form (`gr:ign:<id>`), or null. */
export function parseTourneyButton(customId) {
  const m = /^gr:(reg|unreg|who|conf|ign):(\d+)$/.exec(customId ?? "");
  return m ? { action: m[1], id: Number(m[2]) } : null;
}

/** Register's form, when the sign-ups are one list with the site: the in-game name, as typed on the site. */
function nameForm(t, interaction) {
  return {
    custom_id: `gr:ign:${t.id}`,
    title: `Register: ${t.name}`.slice(0, 45),
    components: [
      {
        type: 1,
        components: [
          {
            type: 4,
            custom_id: "ign",
            style: 1,
            label: "Your in-game name",
            placeholder: "As it shows in Overwatch",
            min_length: 1,
            max_length: 64,
            required: true,
            value: siteName(displayName(interaction)) || undefined,
          },
        ],
      },
    ],
  };
}

/** The in-game name typed in the form. */
export function formName(interaction) {
  const field = (interaction.data?.components ?? []).flatMap((row) => row.components ?? []).find((c) => c.custom_id === "ign");
  return siteName(field?.value);
}

/** The answer to Register for someone already registered. */
function alreadyReply(t, name, row) {
  if (t.phase === "confirming" && !row.confirmed) return `You're registered for ${name}: press **Confirm** in the DM I sent you.`;
  return row.confirmed ? `You're already confirmed for ${name}.` : `You're already registered for ${name}.`;
}

/** `as`: the name they're on the site's list with, when it isn't the one they typed. */
function registeredReply(env, t, name, nowMs, as = "") {
  if (t.phase === "confirming" && nowMs < t.starts_at * 1000) return `✅ You're registered and confirmed for ${name}${as}. It starts ${discordTime(t.starts_at * 1000, "R")}.`;
  return (
    `✅ You're registered for ${name}${as} (${discordTime(t.starts_at * 1000, "F")}).\n` +
    `${confirmMinutes(env)} minutes before it starts I'll DM you a **Confirm** button: press it or you won't be on the list. ` +
    "Keep your DMs from this server open."
  );
}

/**
 * Register, Unregister and Who's signed up on the post. Returns `{ reply, changed }`: the private
 * reply, and whether the post's counts need refreshing; or `{ form }`, Register's in-game name form.
 * When the sign-ups are one list with the site, only Register comes here: the rest is `siteSignup`.
 */
export async function signupButton(env, interaction, action, id, nowMs = Date.now()) {
  const t = await env.DB.prepare("SELECT * FROM tournaments WHERE id = ?").bind(id).first();
  if (!t) return { reply: "I don't know that tournament." };
  const name = `**${escapeMarkdown(t.name)}**`;
  if (t.phase === "cancelled") return { reply: `${name} was cancelled.` };
  const closed = t.phase !== "open" && t.phase !== "confirming";
  const userId = userOf(interaction)?.id;

  if (action === "who") {
    const { results } = await env.DB.prepare("SELECT name, confirmed FROM entrants WHERE tournament_id = ? ORDER BY registered_at, user_id").bind(id).all();
    if (!results.length) return { reply: `Nobody has signed up for ${name} yet.` };
    const confirming = t.phase === "confirming";
    const confirmedCount = results.filter((r) => r.confirmed).length;
    let text = confirming ? `**${results.length} signed up · ${confirmedCount} confirmed**` : `**${results.length} signed up**`;
    for (const [i, r] of results.entries()) {
      const line = `\n${i + 1}. ${escapeMarkdown(r.name)}${confirming && r.confirmed ? " ✅" : ""}`;
      if (text.length + line.length > MESSAGE_MAX - 20) {
        text += `\n…and ${results.length - i} more`;
        break;
      }
      text += line;
    }
    return { reply: text };
  }

  if (closed) return { reply: `Sign-ups for ${name} are closed.` };

  if (action === "reg") {
    if (signsUp(env)) {
      const row = await env.DB.prepare("SELECT confirmed FROM entrants WHERE tournament_id = ? AND user_id = ?").bind(id, userId).first();
      return row ? { reply: alreadyReply(t, name, row) } : { form: nameForm(t, interaction) };
    }
    const confirming = t.phase === "confirming" && nowMs < t.starts_at * 1000;
    const done = await env.DB.prepare(
      `INSERT OR IGNORE INTO entrants (tournament_id, user_id, name, registered_at, confirmed, dm_status) VALUES (?, ?, ?, ?, ?, 'none')`,
    )
      .bind(id, userId, displayName(interaction), nowMs, confirming ? 1 : 0)
      .run();
    if (!done.meta?.changes && !done.changes) {
      const row = await env.DB.prepare("SELECT confirmed FROM entrants WHERE tournament_id = ? AND user_id = ?").bind(id, userId).first();
      return { reply: alreadyReply(t, name, row ?? {}) };
    }
    return { reply: registeredReply(env, t, name, nowMs), changed: true };
  }

  // unreg
  const gone = await env.DB.prepare("DELETE FROM entrants WHERE tournament_id = ? AND user_id = ?").bind(id, userId).run();
  if (!gone.meta?.changes && !gone.changes) return { reply: `You weren't registered for ${name}.` };
  return { reply: `You're no longer registered for ${name}.`, changed: true };
}

/**
 * One list with the site: the form's sign-up (`ign`, with the in-game name), Unregister and Who's
 * signed up, each a call to the site. Returns `{ reply, changed }`, as `signupButton` does.
 */
export async function siteSignup(env, site, interaction, action, id, ign = "", nowMs = Date.now()) {
  const t = await env.DB.prepare("SELECT * FROM tournaments WHERE id = ?").bind(id).first();
  if (!t) return { reply: "I don't know that tournament." };
  const name = `**${escapeMarkdown(t.name)}**`;
  if (t.phase === "cancelled") return { reply: `${name} was cancelled.` };
  const closed = t.phase !== "open" && t.phase !== "confirming";
  const userId = userOf(interaction)?.id;
  const closedReply = { reply: `Sign-ups for ${name} are closed.` };

  if (action === "who") {
    const answer = await site.signups(id);
    if (!answer.entries) return { reply: `I can't find ${name} on the site.` };
    const changed = await setSiteCount(env, t, answer.signups?.count);
    const entries = answer.entries;
    if (!entries.length) return { reply: `Nobody has signed up for ${name} yet.`, changed };
    const confirming = t.phase === "confirming";
    const { results } = await env.DB.prepare("SELECT user_id FROM entrants WHERE tournament_id = ? AND confirmed = 1").bind(id).all();
    const confirmed = new Set(results.map((r) => r.user_id));
    let text = `**${entries.length} signed up**`;
    if (confirming) text += ` · ${entries.filter((e) => confirmed.has(e.discordUserId)).length} confirmed`;
    for (const [i, e] of entries.entries()) {
      const mark = !e.discordUserId ? " · on the site" : confirming && confirmed.has(e.discordUserId) ? " ✅" : "";
      const line = `\n${i + 1}. ${escapeMarkdown(e.name)}${mark}`;
      if (text.length + line.length > MESSAGE_MAX - 20) {
        text += `\n…and ${entries.length - i} more`;
        break;
      }
      text += line;
    }
    return { reply: text, changed };
  }

  if (closed) return closedReply;

  if (action === "unreg") {
    const answer = await site.unregister(id, userId);
    if (answer.status === 409) return closedReply;
    const gone = await env.DB.prepare("DELETE FROM entrants WHERE tournament_id = ? AND user_id = ?").bind(id, userId).run();
    await setSiteCount(env, t, answer.signups?.count);
    if (!answer.removed && !gone.meta?.changes && !gone.changes) return { reply: `You weren't registered for ${name}.`, changed: true };
    return { reply: `You're no longer registered for ${name}.`, changed: true };
  }

  // The form's sign-up.
  if (!ign) return { reply: "Type your in-game name to register." };
  const answer = await site.signUp(id, [{ discordUserId: userId, name: ign }]);
  if (answer.status === 409) return closedReply;
  const result = answer.results?.[0];
  if (!result) return { reply: `I can't find ${name} on the site.` };
  await setSiteCount(env, t, answer.signups?.count);
  const typed = `**${escapeMarkdown(ign)}**`;
  switch (result.status) {
    case "removed":
      return { reply: `An admin took you (or ${typed}) off ${name}'s sign-ups, so you can't register again. Ask the staff.`, changed: true };
    case "name_taken":
      return { reply: `Someone else on Discord signed up for ${name} as ${typed}. Register with your own in-game name.`, changed: true };
    case "too_many":
      return { reply: `${name} can't take more sign-ups. Ask the staff.`, changed: true };
    case "conflict":
      return { reply: "The sign-ups changed just now. Press **Register** again.", changed: true };
  }
  // created, linked (they'd typed the name on the site) or exists.
  const confirming = t.phase === "confirming" && nowMs < t.starts_at * 1000;
  const done = await env.DB.prepare(
    `INSERT OR IGNORE INTO entrants (tournament_id, user_id, name, registered_at, confirmed, dm_status, on_site) VALUES (?, ?, ?, ?, ?, 'none', 1)`,
  )
    .bind(id, userId, result.signup?.name ?? ign, nowMs, confirming ? 1 : 0)
    .run();
  if (!done.meta?.changes && !done.changes) {
    const row = await env.DB.prepare("SELECT confirmed FROM entrants WHERE tournament_id = ? AND user_id = ?").bind(id, userId).first();
    return { reply: alreadyReply(t, name, row ?? {}), changed: true };
  }
  const as = result.signup && result.signup.name !== ign ? ` as **${escapeMarkdown(result.signup.name)}**` : "";
  return { reply: registeredReply(env, t, name, nowMs, as), changed: true };
}

export async function refreshPostById(env, discord, id) {
  const t = await env.DB.prepare("SELECT * FROM tournaments WHERE id = ?").bind(id).first();
  if (t && (t.phase === "open" || t.phase === "confirming")) await refreshPost(env, discord, t);
}

/** The Confirm button in the DM. Returns the DM's new content (the message is updated in place). */
export async function confirmButton(env, interaction, id, nowMs = Date.now()) {
  const t = await env.DB.prepare("SELECT * FROM tournaments WHERE id = ?").bind(id).first();
  const name = t ? `**${escapeMarkdown(t.name)}**` : "this tournament";
  const done = (content) => ({ content, components: [], allowed_mentions: NO_PINGS });
  if (!t) return done("I don't know that tournament.");
  if (t.phase === "cancelled") return done(`${name} was cancelled.`);
  if (t.phase !== "confirming" || nowMs >= t.starts_at * 1000) return done(`Too late: ${name} has started and the list is out.`);
  const userId = userOf(interaction)?.id;
  const row = await env.DB.prepare("SELECT confirmed FROM entrants WHERE tournament_id = ? AND user_id = ?").bind(id, userId).first();
  if (!row) return done(`You're not registered for ${name} any more, so there's nothing to confirm.`);
  if (!row.confirmed) await env.DB.prepare("UPDATE entrants SET confirmed = 1 WHERE tournament_id = ? AND user_id = ?").bind(id, userId).run();
  return done(`✅ **Confirmed.** You're on the list for ${name}. Good luck!`);
}

// ---- The cron, every minute ----

/** Sends the Confirm DMs still pending, as many as this run's budget allows. D1 allows 50 queries a
 * run on the free plan, so the writes are a few statements whatever the number of DMs. */
async function sendConfirmDms(env, discord, t, budget) {
  const { results } = await env.DB.prepare(
    `SELECT e.user_id, d.channel_id FROM entrants e LEFT JOIN dm_channels d ON d.user_id = e.user_id
     WHERE e.tournament_id = ? AND e.dm_status = 'pending' ORDER BY e.registered_at LIMIT 40`,
  )
    .bind(t.id)
    .all();
  const sent = [];
  const failed = [];
  const opened = [];
  for (const { user_id, channel_id } of results) {
    if (budget() < (channel_id ? 3 : 4)) break;
    try {
      let channel = channel_id;
      if (!channel) {
        channel = (await discord.openDm(user_id)).id;
        opened.push({ user_id, channel_id: channel });
      }
      await discord.sendMessage(channel, confirmDm(env, t));
      sent.push(user_id);
    } catch (e) {
      if (!lostAccess(e) && e?.status !== 400) throw e;
      failed.push(user_id);
    }
  }
  const mark = (status, ids) =>
    env.DB.prepare("UPDATE entrants SET dm_status = ? WHERE tournament_id = ? AND user_id IN (SELECT value FROM json_each(?))").bind(
      status,
      t.id,
      JSON.stringify(ids),
    );
  const writes = [];
  if (sent.length) writes.push(mark("sent", sent));
  if (failed.length) writes.push(mark("failed", failed));
  if (opened.length) {
    writes.push(
      env.DB.prepare(
        `INSERT OR REPLACE INTO dm_channels (user_id, channel_id)
         SELECT json_extract(value, '$.user_id'), json_extract(value, '$.channel_id') FROM json_each(?)`,
      ).bind(JSON.stringify(opened)),
    );
  }
  if (writes.length) await env.DB.batch(writes);
}

/**
 * One list with the site: drops the registrations an admin removed there, so they get no DM and
 * aren't on the list. Returns the site's sign-ups, or null when it didn't answer.
 */
async function dropRemoved(env, site, t) {
  const answer = await site.signups(t.id).catch(() => null);
  if (!answer?.entries) return null;
  const onSite = answer.entries.map((e) => e.discordUserId).filter(Boolean);
  await env.DB.prepare("DELETE FROM entrants WHERE tournament_id = ? AND on_site = 1 AND user_id NOT IN (SELECT value FROM json_each(?))")
    .bind(t.id, JSON.stringify(onSite))
    .run();
  return answer.entries;
}

/** At the start: delete the sign-up post and post the list. */
async function start(env, discord, site, t) {
  const entries = signsUp(env) ? await dropRemoved(env, site, t) : null;
  const siteOnly = (entries ?? []).filter((e) => !e.discordUserId).map((e) => e.name);
  const { results } = await env.DB.prepare("SELECT user_id FROM entrants WHERE tournament_id = ? AND confirmed = 1 ORDER BY registered_at, user_id")
    .bind(t.id)
    .all();
  const ids = results.map((r) => r.user_id);
  let listId = null;
  for (const content of listMessages(t, ids, siteOnly)) {
    const message = await discord.sendMessage(t.channel_id, { content, allowed_mentions: NO_PINGS }).catch((e) => {
      if (!lostAccess(e)) throw e;
      return null;
    });
    listId ??= message?.id ?? null;
  }
  await env.DB.prepare("UPDATE tournaments SET phase = 'started', list_message_id = ? WHERE id = ?").bind(listId, t.id).run();
  if (t.message_id) await discord.deleteMessage(t.channel_id, t.message_id).catch(() => null);
}

/** After the start: posts the standings under the list once the site has them. */
async function postResults(env, discord, site, t) {
  const data = await site.tourney(t.id).catch(() => null);
  const results = data?.tourney ? resultsMessage(site, data.tourney) : null;
  if (!results) return;
  const message = await discord
    .sendMessage(t.channel_id, t.list_message_id ? { ...results, message_reference: { message_id: t.list_message_id, fail_if_not_exists: false } } : results)
    .catch((e) => {
      if (!lostAccess(e)) throw e;
      return { id: "gone" };
    });
  await env.DB.prepare("UPDATE tournaments SET results_message_id = ? WHERE id = ?").bind(message.id, t.id).run();
}

export async function runTournaments(env, discord, site, budget, nowMs = Date.now()) {
  const now = Math.floor(nowMs / 1000);
  const confirmAt = now + confirmMinutes(env) * 60;
  const { results } = await env.DB.prepare(
    `SELECT * FROM tournaments
     WHERE (phase = 'open' AND starts_at <= ?) OR phase = 'confirming'
        OR (phase = 'started' AND results_message_id IS NULL AND starts_at > ?)
     ORDER BY starts_at LIMIT 5`,
  )
    .bind(confirmAt, now - RESULTS_WINDOW_SECONDS)
    .all();
  const checkResults = new Date(nowMs).getUTCMinutes() % 10 === 0;

  for (const t of results) {
    if (budget() < 4) return;
    if (t.phase === "open") {
      // Confirming starts: queue a DM for everyone not confirmed yet (and still on the site's list).
      if (signsUp(env)) await dropRemoved(env, site, t);
      await env.DB.batch([
        env.DB.prepare("UPDATE tournaments SET phase = 'confirming' WHERE id = ?").bind(t.id),
        env.DB.prepare("UPDATE entrants SET dm_status = 'pending' WHERE tournament_id = ? AND confirmed = 0 AND dm_status = 'none'").bind(t.id),
      ]);
      t.phase = "confirming";
      await refreshPost(env, discord, t);
    }
    if (t.phase === "confirming") {
      if (now >= t.starts_at) {
        // Last look at the site before the list goes out: it may have been moved or cancelled
        // since the last sync. If the site can't answer, start as planned.
        const st = (await site.tourney(t.id).catch(() => undefined))?.tourney;
        if (st && st.status === "cancelled") await cancelHere(env, discord, t);
        else if (st && toUnix(st.startsAt) > now) await moveHere(env, discord, t, st, now);
        else await start(env, discord, site, t);
      }
      else await sendConfirmDms(env, discord, t, budget);
    } else if (t.phase === "started" && checkResults) {
      await postResults(env, discord, site, t);
    }
  }
}
