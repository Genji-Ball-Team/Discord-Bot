/** A text setting from wrangler.toml or a secret: trimmed, "" when it is not set. */
export const setting = (env, key) => (env[key] ?? "").trim();

/** A minutes setting from wrangler.toml: 1 to 60, `fallback` when it isn't a number. */
export const minutes = (value, fallback = 5) => Math.min(60, Math.max(1, Number(value) || fallback));

/** Discord shows <t:…> in each reader's own time zone. */
export const discordTime = (ms, style = "F") => `<t:${Math.floor(ms / 1000)}:${style}>`;
