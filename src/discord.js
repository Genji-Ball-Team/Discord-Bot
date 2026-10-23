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

/** Most members one list call returns. */
export const MEMBERS_PAGE = 1000;

/** Nobody gets a notification from a message sent with this. */
export const NO_PINGS = { parse: [] };

/** The side line of the bot's embeds: the leaderboard, tourney posts and results. The bot role's colour. */
export const EMBED_COLOR = 0x1c8888;

function hexToBytes(hex) {
  if (!/^(?:[0-9a-f]{2})+$/i.test(hex)) return null;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

/** How far a request's signed time may be from now, so an old signed request can't be sent again. */
const SIGNATURE_MAX_AGE_MS = 5 * 60 * 1000;

/** Discord signs every request with the app's key. Anything unsigned, or signed too long ago, is refused. */
export async function verifyRequest(request, publicKey, nowMs = Date.now()) {
  const signature = hexToBytes(request.headers.get("X-Signature-Ed25519") ?? "");
  const timestamp = request.headers.get("X-Signature-Timestamp");
  const keyBytes = hexToBytes(publicKey ?? "");
  const body = await request.text();
  if (!signature || !timestamp || !keyBytes) return { ok: false, body };
  if (!(Math.abs(nowMs - Number(timestamp) * 1000) <= SIGNATURE_MAX_AGE_MS)) return { ok: false, body };
  try {
    const key = await crypto.subtle.importKey("raw", keyBytes, { name: "Ed25519" }, false, ["verify"]);
    const ok = await crypto.subtle.verify("Ed25519", key, signature, new TextEncoder().encode(timestamp + body));
    return { ok, body };
  } catch {
    return { ok: false, body };
  }
}

class DiscordError extends Error {
  constructor(status, message) {
    super(`Discord ${status}: ${message}`);
    this.status = status;
  }
}

/** The channel or message is gone, or the bot can't see it any more. */
export const lostAccess = (e) => e instanceof DiscordError && (e.status === 403 || e.status === 404);

/** Longest wait before a retry, in seconds. */
const MAX_RETRY_WAIT = 5;
/** Discord briefly down: worth one retry, unless the request may have gone through (a POST could post twice). */
const RETRY_STATUSES = new Set([502, 503, 504]);
const RETRY_METHODS = new Set(["GET", "PUT", "PATCH", "DELETE"]);
/** A request still unanswered after this counts as failed. */
const REQUEST_TIMEOUT_MS = 10_000;

const sleep = (seconds) => new Promise((r) => setTimeout(r, seconds * 1000));

/** Seconds Discord asks to wait: the body's `retry_after` (it has decimals), else the Retry-After header. */
function retryAfter(res, info) {
  const seconds = Number(info?.retry_after ?? res.headers.get("Retry-After") ?? NaN);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : 1;
}

async function send(token, method, path, body, auth) {
  // A file upload is multipart: fetch sets its Content-Type, boundary included.
  const form = body instanceof FormData;
  const headers = form ? {} : { "Content-Type": "application/json" };
  if (auth) headers.Authorization = `Bot ${token}`;
  try {
    return await fetch(API + path, {
      method,
      headers,
      body: body === undefined || form ? body : JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (e) {
    if (e?.name === "TimeoutError") throw new DiscordError(0, `no answer to ${method} ${path} within ${REQUEST_TIMEOUT_MS / 1000} s`);
    throw e;
  }
}

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
    for (let attempt = 0; ; attempt++) {
      if (this.used >= this.budget) throw new DiscordError(0, "out of request budget for this run");
      this.used++;
      const res = await send(this.token, method, path, body, auth);
      const retry = attempt === 0;
      if (res.status === 429) {
        const info = await res.json().catch(() => ({}));
        const wait = retryAfter(res, info);
        const global = info.global === true || res.headers.get("X-RateLimit-Scope") === "global";
        console.warn(`Discord rate limit${global ? " (global)" : ""} on ${method} ${path}: wait ${wait} s`);
        // A longer wait than this is left to the next cron run (or the user's next try).
        const again = retry && wait <= MAX_RETRY_WAIT;
        // A global limit holds every route: this run makes no more requests after the retry.
        if (global) this.budget = this.used + (again ? 1 : 0);
        if (!again) throw new DiscordError(429, info.message ?? "rate limited");
        await sleep(wait);
        continue;
      }
      if (RETRY_STATUSES.has(res.status) && RETRY_METHODS.has(method) && retry) {
        await sleep(1);
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

  /** One page of members after `after` (a user id), with their roles. Needs the Server Members intent. */
  listMembers(guildId, after = "0") {
    return this.call("GET", `/guilds/${guildId}/members?limit=${MEMBERS_PAGE}&after=${after}`);
  }

  addRole(guildId, userId, roleId) {
    return this.call("PUT", `/guilds/${guildId}/members/${userId}/roles/${roleId}`);
  }

  removeRole(guildId, userId, roleId) {
    return this.call("DELETE", `/guilds/${guildId}/members/${userId}/roles/${roleId}`);
  }
}
