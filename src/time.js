/** Discord shows <t:…> in each reader's own time zone. */
export const discordTime = (ms, style = "F") => `<t:${Math.floor(ms / 1000)}:${style}>`;
