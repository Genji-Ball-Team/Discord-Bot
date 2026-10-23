// Talking to Discord: checking that a request really comes from Discord, and the few REST calls the
// bot makes (post, edit and delete messages, upload a picture, open DMs, read the members and change
// their rank roles).

const API = "https://discord.com/api/v10";

export const InteractionType = { PING: 1, COMMAND: 2, COMPONENT: 3, AUTOCOMPLETE: 4, MODAL_SUBMIT: 5 };
export const ResponseType = {
  PONG: 1,
  MESSAGE: 4,
  DEFERRED_MESSAGE: 5,
  DEFERRED_UPDATE: 6,
  UPDATE_MESSAGE: 7,
  AUTOCOMPLETE: 8,
  MODAL: 9,
};
export const EPHEMERAL = 64;

/** Nobody gets a notification from a message sent with this. */
export const NO_PINGS = { parse: [] };

/** The colour of the bot's embeds: the leaderboard, tourney posts and results. */
export const RED = 0xed4245;

function hexToBytes(hex) {
  if (!/^(?:[0-9a-f]{2})+$/i.test(hex)) return null;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

/** Discord signs every request with the app's key. Anything unsigned is refused. */
export async function verifyRequest(request, publicKey) {
  const signature = hexToBytes(request.headers.get("X-Signature-Ed25519") ?? "");
  const timestamp = request.headers.get("X-Signature-Timestamp");
  const keyBytes = hexToBytes(publicKey ?? "");
  const body = await request.text();
  if (!signature || !timestamp || !keyBytes) return { ok: false, body };
  try {
    const key = await crypto.subtle.importKey("raw", keyBytes, { name: "Ed25519" }, false, ["verify"]);
    const ok = await crypto.subtle.verify("Ed25519", key, signature, new TextEncoder().encode(timestamp + body));
    return { ok, body };
  } catch {
    return { ok: false, body };
  }
}

export class DiscordError extends Error {
  constructor(status, message) {
    super(`Discord ${status}: ${message}`);
    this.status = status;
  }
}

/** The channel or message is gone, or the bot can't see it any more. */
export const lostAccess = (e) => e instanceof DiscordError && (e.status === 403 || e.status === 404);

export class Discord {
  /** `budget`: most requests this run may make (the free plan allows 50 subrequests a run). */
  constructor(env, budget = Infinity) {
    this.token = env.DISCORD_TOKEN;
    this.appId = env.DISCORD_APPLICATION_ID;
    this.budget = budget;
    this.used = 0;
  }

  get left() {
    return this.budget - this.used;
  }

  async call(method, path, body, { auth = true } = {}) {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (this.used >= this.budget) throw new DiscordError(0, "out of request budget for this run");
      this.used++;
      // A file upload is multipart: fetch sets its Content-Type, boundary included.
      const form = body instanceof FormData;
      const headers = form ? {} : { "Content-Type": "application/json" };
      if (auth) headers.Authorization = `Bot ${this.token}`;
      const res = await fetch(API + path, { method, headers, body: body === undefined || form ? body : JSON.stringify(body) });
      if (res.status === 429 && attempt === 0) {
        const info = await res.json().catch(() => ({}));
        const wait = Math.min(Number(info.retry_after ?? 1), 5);
        await new Promise((r) => setTimeout(r, wait * 1000));
        continue;
      }
      if (res.status === 204) return null;
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new DiscordError(res.status, data?.message ?? res.statusText);
      return data;
    }
  }

  // Interaction follow-ups use the interaction token, not the bot token.
  editOriginal(token, message) {
    return this.call("PATCH", `/webhooks/${this.appId}/${token}/messages/@original`, message, { auth: false });
  }

  sendMessage(channelId, message) {
    return this.call("POST", `/channels/${channelId}/messages`, message);
  }

  /** A message with one file attached: `file` is `{ name, type, data }`, `data` the bytes. */
  sendFile(channelId, message, file) {
    const form = new FormData();
    form.set("payload_json", JSON.stringify({ ...message, attachments: [{ id: 0, filename: file.name }] }));
    form.set("files[0]", new Blob([file.data], { type: file.type }), file.name);
    return this.call("POST", `/channels/${channelId}/messages`, form);
  }

  editMessage(channelId, messageId, message) {
    return this.call("PATCH", `/channels/${channelId}/messages/${messageId}`, message);
  }

  deleteMessage(channelId, messageId) {
    return this.call("DELETE", `/channels/${channelId}/messages/${messageId}`);
  }

  openDm(userId) {
    return this.call("POST", "/users/@me/channels", { recipient_id: userId });
  }

  /** Up to 1,000 members after `after` (a user id), with their roles. Needs the Server Members intent. */
  listMembers(guildId, after = "0") {
    return this.call("GET", `/guilds/${guildId}/members?limit=1000&after=${after}`);
  }

  addRole(guildId, userId, roleId) {
    return this.call("PUT", `/guilds/${guildId}/members/${userId}/roles/${roleId}`);
  }

  removeRole(guildId, userId, roleId) {
    return this.call("DELETE", `/guilds/${guildId}/members/${userId}/roles/${roleId}`);
  }
}
