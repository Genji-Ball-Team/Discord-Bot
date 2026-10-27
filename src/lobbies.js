// The lobby status: one message in LOBBY_STATUS_CHANNEL_ID, kept up to date by the cron every minute,
// saying whether a ranked lobby is open in LOBBY_STATUS_REGION and who is in it. It reads
// genjiball.us's live lobbies (`GET /api/lobbies`), which the hosts' host tool keeps with a heartbeat
// a minute. Posted once, then only edited, and only when what it shows changed: an edit notifies
// nobody. Where it is and what it shows are in bot_state.

import { NO_PINGS, lostAccess } from "./discord.js";
import { escapeMarkdown, regionInfo, regionOf } from "./site.js";
import { setting } from "./time.js";
import { getState } from "./results.js";

const ACTIVE_COLOR = 0x23a55a;
const OFFLINE_COLOR = 0x80848e;

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** One lobby's players: the count, then each name on its own line (none from a host tool too old to send them). */
function playerLines(lobby) {
  const lines = [`👥 **${plural(lobby.players, "Current Player")}**`];
  if (Array.isArray(lobby.names)) lines.push(...lobby.names.map((name, i) => `${i + 1}. ${escapeMarkdown(name)}`));
  return lines;
}

/** The status message for `lobbies`, the region's open lobbies as the site lists them. */
export function lobbyStatusMessage(site, region, lobbies) {
  const info = regionInfo(region);
  const active = lobbies.length > 0;
  const lines = [active ? "Status: **Active** ✅" : "Status: **Offline** ❌"];
  if (!active) lines.push("No ranked lobby is open right now.");
  // Two hosts at once: each lobby's players apart, numbered from 1.
  lobbies.forEach((lobby, i) => {
    lines.push("", ...(lobbies.length > 1 ? [`**Lobby ${i + 1}**`] : []), ...playerLines(lobby));
  });
  return {
    embeds: [
      {
        title: `${info.flag} ${info.label} Lobby Status`,
        url: site.liveUrl(info.id),
        description: lines.join("\n").slice(0, 4096),
        color: active ? ACTIVE_COLOR : OFFLINE_COLOR,
        footer: { text: "Watch it live on genjiball.us/live · Updates every minute" },
      },
    ],
    allowed_mentions: NO_PINGS,
  };
}

const setState = (env, key, value) => env.DB.prepare("INSERT OR REPLACE INTO bot_state (key, value) VALUES (?, ?)").bind(key, value).run();

/**
 * On the cron, every minute: posts the status message if there's none (or it was deleted), else edits
 * it when what it shows changed. A site error leaves it as it was until the next minute.
 */
export async function refreshLobbyStatus(env, discord, site, budget) {
  const channelId = setting(env, "LOBBY_STATUS_CHANNEL_ID");
  if (!channelId || budget() < 3) return;
  const region = regionOf(setting(env, "LOBBY_STATUS_REGION") || "eu");
  const { lobbies = [] } = await site.lobbies(region);
  const message = lobbyStatusMessage(site, region, lobbies);
  const shown = JSON.stringify(message);
  // `channel/message`: a new channel gets a new message.
  const [postedIn, messageId] = ((await getState(env, "lobby_status_message")) ?? "").split("/");
  if (postedIn === channelId && messageId) {
    if ((await getState(env, "lobby_status_shown")) === shown) return;
    try {
      await discord.editMessage(channelId, messageId, message);
      await setState(env, "lobby_status_shown", shown);
      return;
    } catch (e) {
      // Deleted: posted again below. No access: said in the log, and tried again next minute.
      if (e.status !== 404) throw e;
    }
  }
  try {
    const posted = await discord.sendMessage(channelId, message);
    await setState(env, "lobby_status_message", `${channelId}/${posted.id}`);
    await setState(env, "lobby_status_shown", shown);
  } catch (e) {
    if (lostAccess(e)) console.error(`lobby status: can't post in ${channelId}`);
    else throw e;
  }
}
