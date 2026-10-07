// Tournament sign-ups: /host tournament posts a sign-up message players react to. A few minutes
// before the start the bot closes sign-ups, posts the list of who signed up, and DMs each of them.

import { DiscordError, NO_PINGS } from "./discord.js";
import { REGIONS, regionOf } from "./site.js";
import { discordTime, nextStart, parseTime } from "./time.js";

function regionSettings(env, region) {
  const up = region.toUpperCase();
  return {
    roleId: (env[`${up}_ROLE_ID`] ?? "").trim(),
    time: env[`${up}_DEFAULT_TIME`] ?? "21:00",
    timeZone: env[`${up}_TIMEZONE`] ?? (region === "na" ? "America/New_York" : "Europe/Moscow"),
  };
}

const emojiOf = (env) => env.SIGNUP_EMOJI || "✅";
const reminderMinutes = (env) => Math.max(1, Number(env.REMINDER_MINUTES) || 5);

function signupEmbed(env, t, closedNote) {
  const info = REGIONS[t.region];
  const ms = t.starts_at * 1000;
  const lines = [
    `🕘 **${discordTime(ms, "F")}** (${discordTime(ms, "R")})`,
    "*That's shown in your own time zone.*",
    "",
    closedNote ?? `React with ${emojiOf(env)} to sign up. You'll get a DM ${reminderMinutes(env)} minutes before it starts.`,
  ];
  return {
    title: `🏆 ${t.name}`,
    description: lines.join("\n"),
    color: t.region === "na" ? 0xb22234 : 0x003399,
    fields: [
      { name: "Region", value: `${info.flag} ${info.label}`, inline: true },
      { name: "Host", value: `<@${t.created_by}>`, inline: true },
      { name: "How to join", value: "Search **Genji Ball 1.3.3** in the Overwatch game browser.", inline: false },
    ],
    footer: { text: `Tournament #${t.id}` },
  };
}

/** /host tournament region day [time] [name] */
export async function hostTournament(env, discord, interaction, options, nowMs = Date.now()) {
  const region = regionOf(options.region);
  const settings = regionSettings(env, region);
  const time = parseTime(options.time ?? settings.time);
  if (!time) return `I couldn't read the time **${options.time}**. Try \`21:00\` or \`9pm\`.`;

  const startMs = nextStart(options.day, time, settings.timeZone, nowMs);
  if (startMs - nowMs < (reminderMinutes(env) + 1) * 60_000) {
    return `That's less than ${reminderMinutes(env) + 1} minutes away, too soon for sign-ups. Pick a later time.`;
  }

  const t = {
    guild_id: interaction.guild_id,
    channel_id: interaction.channel_id ?? interaction.channel?.id,
    region,
    name: (options.name ?? `${REGIONS[region].label} Weekly Tournament`).slice(0, 100),
    starts_at: Math.floor(startMs / 1000),
    created_by: interaction.member?.user?.id ?? interaction.user?.id,
  };
  const row = await env.DB.prepare(
    `INSERT INTO tournaments (guild_id, channel_id, region, name, starts_at, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
  )
    .bind(t.guild_id, t.channel_id, t.region, t.name, t.starts_at, t.created_by, Math.floor(nowMs / 1000))
    .first();
  t.id = row.id;

  let message;
  try {
    message = await discord.sendMessage(t.channel_id, {
      content: settings.roleId ? `<@&${settings.roleId}>` : undefined,
      embeds: [signupEmbed(env, t)],
      allowed_mentions: settings.roleId ? { parse: [], roles: [settings.roleId] } : NO_PINGS,
    });
    await discord.react(t.channel_id, message.id, emojiOf(env));
  } catch (e) {
    await env.DB.prepare("DELETE FROM tournaments WHERE id = ?").bind(t.id).run();
    if (e instanceof DiscordError && (e.status === 403 || e.status === 404)) {
      return "I can't post in this channel. Give me **View Channel**, **Send Messages**, **Embed Links**, **Add Reactions** and **Read Message History** here.";
    }
    throw e;
  }
  await env.DB.prepare("UPDATE tournaments SET message_id = ? WHERE id = ?").bind(message.id, t.id).run();

  return `Posted the ${REGIONS[region].label} sign-ups for ${discordTime(startMs, "F")}. Sign-ups close and DMs go out ${reminderMinutes(env)} minutes before.`;
}

/** /host cancel region: cancels this server's next tournament in that region. */
export async function cancelTournament(env, discord, interaction, options, nowMs = Date.now()) {
  const region = regionOf(options.region);
  const t = await env.DB.prepare(
    `SELECT * FROM tournaments WHERE guild_id = ? AND region = ? AND status = 'open' AND starts_at > ?
     ORDER BY starts_at LIMIT 1`,
  )
    .bind(interaction.guild_id, region, Math.floor(nowMs / 1000))
    .first();
  if (!t) return `There's no upcoming ${REGIONS[region].label} tournament with open sign-ups.`;
  await env.DB.prepare("UPDATE tournaments SET status = 'cancelled' WHERE id = ?").bind(t.id).run();
  if (t.message_id) {
    const embed = signupEmbed(env, t, "❌ **This tournament was cancelled.**");
    embed.title = `~~🏆 ${t.name}~~ — Cancelled`;
    embed.color = 0x808080;
    await discord.editMessage(t.channel_id, t.message_id, { embeds: [embed] }).catch(() => null);
  }
  return `Cancelled **${t.name}** (${discordTime(t.starts_at * 1000, "F")}).`;
}

/** Everyone who reacted with the sign-up emoji, bots left out. */
async function readSignups(env, discord, t) {
  const users = [];
  let after;
  for (;;) {
    const page = await discord.reactions(t.channel_id, t.message_id, emojiOf(env), after);
    for (const u of page) if (!u.bot) users.push({ id: u.id, name: u.global_name || u.username });
    if (page.length < 100) break;
    after = page[page.length - 1].id;
  }
  return users;
}

/** "1. <@id>" lines in messages under Discord's 2000-character limit. */
export function listMessages(header, users) {
  const lines = users.map((u, i) => `${i + 1}. <@${u.id}>`);
  const messages = [];
  let current = header;
  for (const line of lines) {
    if (current.length + line.length + 1 > 1900) {
      messages.push(current);
      current = "";
    }
    current += (current ? "\n" : "") + line;
  }
  messages.push(current);
  return messages;
}

/** Sign-ups close: read the reactions, post the list, and queue the DMs. */
async function closeSignups(env, discord, t) {
  let users = [];
  try {
    users = await readSignups(env, discord, t);
  } catch (e) {
    if (e instanceof DiscordError && e.status === 404) {
      // The sign-up message was deleted: nothing to do.
      await env.DB.prepare("UPDATE tournaments SET status = 'cancelled' WHERE id = ?").bind(t.id).run();
      return;
    }
    throw e;
  }
  if (users.length) {
    await env.DB.batch(
      users.map((u) =>
        env.DB.prepare("INSERT OR IGNORE INTO signups (tournament_id, user_id, name) VALUES (?, ?, ?)").bind(t.id, u.id, u.name),
      ),
    );
  }

  const start = t.starts_at * 1000;
  const header = users.length
    ? `📋 **${t.name}** starts ${discordTime(start, "R")} (${discordTime(start, "t")}). **${users.length}** signed up:`
    : `📋 **${t.name}** starts ${discordTime(start, "R")}. Nobody signed up.`;
  let first;
  for (const content of listMessages(header, users)) {
    const sent = await discord.sendMessage(t.channel_id, {
      content,
      allowed_mentions: NO_PINGS,
      message_reference: first ? undefined : { message_id: t.message_id, fail_if_not_exists: false },
    });
    first ??= sent;
  }

  await discord
    .editMessage(t.channel_id, t.message_id, { embeds: [signupEmbed(env, t, `🔒 Sign-ups are closed: **${users.length}** signed up.`)] })
    .catch(() => null);
  await env.DB.prepare("UPDATE tournaments SET status = ?, list_message_id = ? WHERE id = ?")
    .bind(users.length ? "reminding" : "done", first?.id ?? null, t.id)
    .run();
}

async function dmChannel(env, discord, userId) {
  const known = await env.DB.prepare("SELECT channel_id FROM dm_channels WHERE user_id = ?").bind(userId).first();
  if (known) return known.channel_id;
  const channel = await discord.openDm(userId);
  await env.DB.prepare("INSERT OR REPLACE INTO dm_channels (user_id, channel_id) VALUES (?, ?)").bind(userId, channel.id).run();
  return channel.id;
}

/** Sends the waiting DMs, as many as this run's request budget allows. */
async function sendReminders(env, discord, t, nowMs) {
  const info = REGIONS[t.region];
  const start = t.starts_at * 1000;
  const tooLate = nowMs > start + 30 * 60_000;
  const pending = tooLate
    ? []
    : (
        await env.DB.prepare("SELECT user_id FROM signups WHERE tournament_id = ? AND dm_status = 'pending' LIMIT 50")
          .bind(t.id)
          .all()
      ).results;

  for (const { user_id } of pending) {
    if (discord.left < 4) return; // the next cron run carries on
    let status = "sent";
    try {
      const channelId = await dmChannel(env, discord, user_id);
      await discord.sendMessage(channelId, {
        content:
          `⏰ **${t.name}** (${info.flag} ${info.label}) starts ${discordTime(start, "R")}, at ${discordTime(start, "t")}.\n` +
          "Join the lobby: search **Genji Ball 1.3.3** in the Overwatch game browser. Good luck!",
        allowed_mentions: NO_PINGS,
      });
    } catch (e) {
      if (!(e instanceof DiscordError) || e.status === 0) throw e;
      // 403: their DMs are closed. 404: the account is gone. Either way, no retry.
      if (e.status === 403 || e.status === 404) status = "failed";
      else throw e;
    }
    await env.DB.prepare("UPDATE signups SET dm_status = ? WHERE tournament_id = ? AND user_id = ?").bind(status, t.id, user_id).run();
  }

  if (!tooLate) {
    const left = await env.DB.prepare("SELECT 1 FROM signups WHERE tournament_id = ? AND dm_status = 'pending' LIMIT 1")
      .bind(t.id)
      .first();
    if (left) return;
  }

  // All sent (or too late to bother): note who couldn't be reached, and finish.
  const failed = (
    await env.DB.prepare("SELECT user_id FROM signups WHERE tournament_id = ? AND dm_status = 'failed'").bind(t.id).all()
  ).results;
  if (failed.length) {
    await discord
      .sendMessage(t.channel_id, {
        content: `Couldn't DM ${failed.map((f) => `<@${f.user_id}>`).join(", ")} (DMs closed): ${t.name} starts ${discordTime(start, "R")}!`,
        allowed_mentions: { parse: [], users: failed.slice(0, 100).map((f) => f.user_id) },
      })
      .catch(() => null);
  }
  await env.DB.prepare("UPDATE tournaments SET status = 'done' WHERE id = ?").bind(t.id).run();
}

/** The cron's tournament work: close due sign-ups and send reminders. */
export async function runReminders(env, discord, nowMs = Date.now()) {
  const due = Math.floor(nowMs / 1000) + reminderMinutes(env) * 60;
  const { results } = await env.DB.prepare(
    `SELECT * FROM tournaments WHERE status IN ('open', 'reminding') AND starts_at <= ? AND message_id IS NOT NULL
     ORDER BY starts_at LIMIT 5`,
  )
    .bind(due)
    .all();
  for (const t of results) {
    if (discord.left < 6) return;
    if (t.status === "open") {
      await closeSignups(env, discord, t);
      t.status = "reminding";
    }
    const fresh = await env.DB.prepare("SELECT status FROM tournaments WHERE id = ?").bind(t.id).first();
    if (fresh?.status === "reminding") await sendReminders(env, discord, t, nowMs);
  }
}
