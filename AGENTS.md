# Genji Ball Discord bot

The Discord bot for the Genji Ball Ranked server: one Cloudflare Worker (plain JavaScript, ES modules) with its own D1 database. Free tier only. The [README](README.md) says what each command does and how the bot is set up.

## Commands

| Command | Use |
|---|---|
| `npm ci` | Install |
| `npm test` | The tests (`node --test`, Node 22.5 or newer). What CI runs. **It must pass before a change is done.** |
| `npm run register` | Send `scripts/commands.js` to Discord. Needed after changing a command's name or options |
| `npm run deploy` | Deploy the Worker |
| `npm run db:setup` | Run `schema.sql` on the live database |

The tests use an in-memory D1 (`node:sqlite`) and fake Discord and site APIs behind `fetch` (`test/helpers.js`). They can't open Discord: a PR says what was tried with the real bot.

## How it works

- **Interactions.** Discord sends slash commands, button presses and autocomplete to `POST /interactions`, signed with Ed25519 (`verifyRequest` in `src/discord.js`). Discord wants an answer within 3 seconds: anything that calls the site or Discord answers "deferred" at once and finishes in `ctx.waitUntil`, editing the reply (`src/index.js`).
- **Cron.** Every minute: tournament sign-ups closing and their DMs (`src/tournament.js`), and every `LEADERBOARD_REFRESH_MINUTES` the live leaderboards.
- **The site.** Every number comes from genjiball.us's public API (`src/site.js`), documented in genjiball-ranked's [`docs/api.md`](https://github.com/Genji-Ball-Team/genjiball-ranked/blob/main/docs/api.md) ("Site"). The bot only reads it and has no token: it never changes the site.

## Limits

- **Outgoing requests.** A Worker run on the free plan makes at most 50 requests. The cron's `Discord` client gets a budget (`new Discord(env, 45)`) and counts site requests too: cron work checks what's left before each step and carries on in the next minute rather than running out halfway.
- **genjiball-ranked's D1 is on the free tier too.** Each site request costs it reads, and some are expensive (a player search reads every alias, `/stats` reads every rated round). Don't call the site more than needed: render once and reuse, and cache what autocomplete and repeated commands ask for.
- **Discord rate limits.** `Discord.call` retries a 429 once. Bulk work (DMs) is spread over cron runs.

## Discord habits

- **No pings unless meant.** Every message sets `allowed_mentions` (`NO_PINGS` by default). Only a sign-up post pings its region's role, and only the "couldn't DM" note pings the people in it.
- **Staff commands** are checked in the bot (`isStaff`: the `STAFF_ROLE_ID` role or Administrator), not only hidden in Discord's settings. Their replies are ephemeral.
- **Regions.** EU and NA are separate everywhere, like on the site: a region option or button, never a mixed list.
- Escape player names for markdown (`escapeMarkdown`) and keep messages under Discord's limits (2000 characters, 25 embed fields, 25 autocomplete choices).

## Config and data

- Settings are `[vars]` in `wrangler.toml`, read through a small helper with a default. The bot token is a `wrangler secret` (`DISCORD_TOKEN`), never in the repo.
- The schema is `schema.sql`, run on the live database with `npm run db:setup`. It must stay safe to run again: `CREATE TABLE IF NOT EXISTS`. A change to an existing table is a new `ALTER TABLE` statement run by hand on the live database; say so in the PR.

## Deploying

Deploy only to the Genji Ball Cloudflare account, the one genjiball.us is on: check `npx wrangler whoami` first, never a personal account. After a change to `scripts/commands.js`, also `npm run register`.

## PR habits

- One topic per PR, branched from `main`. Fill in `.github/PULL_REQUEST_TEMPLATE.md`, and link the issue (`Fixes #12`).
- Match the surrounding code: `camelCase`, small modules, a comment saying why where it isn't obvious, a test for each behaviour.
- Commits are made as `GenjiBallTeam`.

## Other repos

The bot is one of four repos in the Genji-Ball-Team org, cloned side by side in the same parent folder:

| Repo | What it is |
|---|---|
| `GenjiBall-CE` | The game (OverPy Workshop mode). Ranked logging is on its `v1.3.3R` branch |
| `genjiball-ranked` | Cloudflare Worker: upload API, log parser, ratings, website at genjiball.us. The API this bot reads |
| `genjiball-host-tool` | Tauri app: watches the host's Workshop log folder and uploads matches |
| `Discord-Bot` (this one) | The Discord bot |

- A feature the API doesn't have yet is an issue (and PR) in genjiball-ranked first, linked from here (`Genji-Ball-Team/genjiball-ranked#12`). Posting to Discord is this bot's job: the ranked server only offers the API it reads.
- Each repo has its own `AGENTS.md`; follow it when working there.
