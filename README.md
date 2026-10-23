# Genji Ball Discord bot

The Discord bot for the Genji Ball Ranked server. It runs on Cloudflare Workers, like genjiball.us, so nothing has to stay running on your PC.

## Commands

Everything is under **`/gr`**.

| Command | Who | What |
|---|---|---|
| `/gr stats player [region]` | Everyone | A player's rating, tier, rank, rounds, win %, kills, deflects, peak, streaks and recent form. Names autocomplete. |
| `/gr leaderboard [region] [page]` | Staff | Posts a one-off leaderboard (20 a page, up to page 5). Its EU and NA buttons switch that message; "Full leaderboard" opens the site. |
| `/gr results tourney` | Staff | Posts a finished tourney's picture and link in `TOURNEY_RESULTS_CHANNEL_ID`, as the bot does when one is marked done: for tourneys from before that, or one verified after its picture went up. `tourney` is the number in its genjiball.us link. |
| `/gr link user player` | Staff | Links a member to their genjiball.us player (names autocomplete) and gives them their **rank role** at once. See [Rank roles](#rank-roles). |
| `/gr unlink user` | Staff | Removes the link and puts them back on Unranked. |
| `/gr setup leaderboard [channel]` | Staff | Posts the **live leaderboard** (EU top 20, updated every 5 minutes, EU/NA buttons and a "Full leaderboard" link to genjiball.us). Its buttons open a private copy, so the channel's board stays the same for everyone. |

"Staff" means the role in `STAFF_ROLE_ID`, plus server admins. Anyone else gets "Only Staff can use this".

## How a tournament runs

Admins make tourneys on **genjiball.us** (the admin page), with their lobbies and hosts, as before.

1. **The post.** Within `TOURNEY_REFRESH_MINUTES` (5) of a tourney being made on the site, the bot posts its sign-up in `TOURNEY_CHANNEL_ID`: compact: its name (opening its page on the site), one line, then the start time (in each reader's own time zone), region and sign-up count in three boxes, with **✅ Register**, **Unregister** (red) and **👥 Player list**. It never pings anyone. Each button answers privately. **Register** asks for your in-game name (your server name filled in) and signs you up on the site too: see [One list with the site](#one-list-with-the-site). When `TOURNEY_CHANNEL_ID` changes, the sign-ups still open move to the new channel on the next sync (posted again there, the old post deleted), with everyone registered, and their list and standings follow.
2. **5 minutes before** (`CONFIRM_MINUTES`), everyone registered gets a DM: "⏰ Tournament starting in 5 minutes" with a **Confirm** button. Anyone who doesn't press it isn't playing. Register stays open, and registering now confirms at once. Players with DMs closed never get the button, so they're out.
3. **At the start**, the sign-up post is deleted and the list of confirmed players is posted as @mentions that notify nobody, ending "Hosts: split the lobbies from this list."
4. When an admin marks the tourney **done** on the site (with lobby standings), the bot posts the standings under the list, and a picture of the tourney's page on the site with its link in `TOURNEY_RESULTS_CHANNEL_ID` (see below).

Changes on the site follow within 5 minutes: a new name or start time updates the post (moved later during the 5 confirm minutes: back to sign-ups, and the DMs go out again before the new start), and a cancelled or deleted tourney's post is crossed out. Right before posting the list, the bot checks the site once more, so a last-minute move or cancel is caught too.

### One list with the site

With the `SITE_TOKEN` secret set, Discord and the tourney's page on genjiball.us share one sign-up list:

- **Register** signs you up on the site with the in-game name you type. A name someone already typed on the page with no Discord account is you: you take that sign-up. A name another Discord user has is refused.
- **Unregister** takes you off the site's list too.
- The post's count and **Player list** are the site's: names typed on the page are counted and listed ("on the site"). A name typed on the page shows up on the post within 5 minutes.
- An admin who removes you on the site's admin page removes you here too: no Confirm DM, not on the list.
- Players who signed up only on the page can't get the Confirm DM. The list at the start names them apart, for the hosts.
- Registrations from before `SITE_TOKEN` was set are sent within 5 minutes, under the server name they registered with. One whose name another Discord user already has stays registered in Discord only, until the player presses **Register** again and types another name.

Without `SITE_TOKEN` the bot keeps its own list, as before, and doesn't use the page's sign-ups.

## Tournament results

Every tournament match the site rates is posted in `RESULTS_CHANNEL_ID`, one post per lobby's match: the tourney and lobby, region, rounds and date, then each player ranked as in the standings (most wins, ties broken by kills) with their wins, kills and rating before → after with the change. No pings, no emojis, a side line in the bot role's colour (#1c8888) like the other posts.

The bot follows the site's match feed (checked every 5 minutes; the site rates every 10), so a result shows up about 10–15 minutes after the match is uploaded. A longer copy of the match edits the post, and a voided match's post is deleted. A later recompute of the ratings doesn't change a post that's already up. Matches from before the bot started following the feed are never posted.

### The finished tourney as a picture

When a tourney is marked done, the bot also posts it in `TOURNEY_RESULTS_CHANNEL_ID` (the ranked results channel, where the rank-ups go too): an embed with the same side line as the bot's other posts, the tourney's name and link, and a picture of its page on genjiball.us (the title, date, region and every lobby's winner and standings table, as on the site, without the host's in-game screenshot). Cloudflare's browser takes it: the `[browser]` binding in `wrangler.toml` (Browser Run's screenshot quick action, `src/screenshot.js`). No token or setup beyond deploying. The free plan's 10 browser minutes a day are plenty: a picture takes a few seconds. If the picture can't be taken, the embed is posted without it. The picture is taken once, when the standings come in: a lobby verified later isn't redrawn. The browser runs in UTC, so the start time on the picture is UTC.

## Rank roles

Staff link each member to their genjiball.us player with `/gr link`. From then on the bot keeps one rank role on them, the role of their tier in `RANK_ROLES` (Rookie, Apprentice, Master, Grandmaster, Ascendant, Champion, Sovereign), or `UNRANKED_ROLE_ID` below Rookie or before they're rated (Rookie, from 1100, is on the site and in Discord only: the game has no Rookie tag):

- **Their best region counts.** Grandmaster in EU and Apprentice in NA gets Grandmaster.
- **Every 5 minutes** (`RANK_REFRESH_MINUTES`) it reads the server's members and every linked player's tier from the site (one request each), and fixes whoever's role is wrong: a climb or drop, a rank role changed by hand, someone who left and rejoined. The site rates every 10 minutes, so a change shows within about 15.
- **A climb** is posted in `RANKUP_CHANNEL_ID`: "**Fealthy** has ranked up to **Grandmaster** 🏆", pinging nobody. Drops and new links aren't posted.
- It only ever adds or removes the rank roles, one at a time. Every other role stays as it is. Inactive players keep their rank.
- Unlinked members are never touched.

It needs two things in Discord: **Server Members Intent** on (Developer Portal → Bot), and the bot's role **above all the rank roles**, with **Manage Roles** (Server Settings → Roles). It can't change the server owner's roles.

### God and Demigod

The 1v1 tourney's winner is **God** and the runner-up **Demigod** (at most 1 and 3 per region). They're titles, not ranks: Staff give the roles in `GOD_ROLE_IDS` and `DEMIGOD_ROLE_IDS` by hand, one per region, and the player keeps their rank role too. The bot only reads them, for linked members, at each check:

- `/gr leaderboard` and the live leaderboard list them above everyone on page 1 (God, then Demigod) with their Elo and their @mention, which Discord colours with their role and which pings nobody. The rest are numbered from 1 without them.
- genjiball.us shows them the same way on its leaderboard (God white, Demigod dark red): it reads them from the bot's `GET /titles` (genjiball-ranked `src/site/titles.ts`).
- The game doesn't change: its top 10 and rank tags stay the real ratings.

A title role on someone who isn't linked does nothing: `/gr link` them first.

## Deploying a change

Open a terminal in this folder (in File Explorer: click the address bar, type `cmd`, press Enter):

```
npm install
npm run deploy
```

`deploy` first applies any new migration in `migrations/` to the live database, then deploys the Worker, so the new tables are there when the new code runs. (`npm run db:migrate:remote` applies the migrations without deploying; `npm run db:migrate:local` does the local database.) A schema change is a new file in `migrations/`; never edit one that was already merged.

Changed the commands (`scripts/commands.js`)? Also `npm run register`: it asks for the bot token and puts the commands in the Genji Ball server (`DISCORD_GUILD_ID`), where they show up at once.

### One-time step for the existing production database

The live database was built from the old `schema.sql`, before migrations, so it already has every table `0001_initial.sql` creates. Run this **once**, before the first `npm run deploy` that has migrations. It creates wrangler's `d1_migrations` table and records `0001_initial.sql` as applied, so `deploy` skips it:

```
npx wrangler whoami
npx wrangler d1 execute genjiball-discord-bot --remote --command "CREATE TABLE IF NOT EXISTS d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL); INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0001_initial.sql');"
npx wrangler d1 migrations list DB --remote
```

`whoami` must show the Genji Ball account (`c212ad20cc4f4b5382766735f57b91c3`). `migrations list` should then list only the migrations after `0001_initial.sql` (none, or `0002_drop_old_tables.sql` and later), which `npm run deploy` applies. A new database (not production) skips this step: `npm run db:migrate:remote` or `npm run deploy` creates everything.

Deploy only to the Genji Ball Cloudflare account, the one genjiball.us is on: check `npx wrangler whoami` first, never a personal account.

The bot token is a secret on Cloudflare, never in this repo: `npx wrangler secret put DISCORD_TOKEN`. So is the site's: `npx wrangler secret put SITE_TOKEN`, the same value as genjiball.us's `BOT_TOKEN` secret (in genjiball-ranked: `npx wrangler secret put BOT_TOKEN`).

## Setting it up from scratch

1. Discord Developer Portal → New Application. Copy the **Application ID** and **Public Key** into `wrangler.toml`. On **Bot**, Reset Token and keep it.
2. Invite it: `https://discord.com/oauth2/authorize?client_id=YOUR_APPLICATION_ID&scope=bot+applications.commands&permissions=268487680` (View Channels, Send Messages, Embed Links, Attach Files, for the tourney pictures, and Manage Roles, for the rank roles. It only deletes its own posts, which needs nothing more). On **Bot**, turn on **Server Members Intent**.
3. `npx wrangler login`, `npx wrangler d1 create genjiball-discord-bot` (paste the id into `wrangler.toml`), `npm run db:migrate:remote`, `npx wrangler secret put DISCORD_TOKEN`, `npm run deploy`.
4. Developer Portal → General Information → **Interactions Endpoint URL**: the address `deploy` printed, plus `/interactions`. Save.
5. `npm run register`.

## Settings and data

Settings are `[vars]` in `wrangler.toml` (each has a comment there). Empty means the feature is off.

| Setting | What |
|---|---|
| `DISCORD_APPLICATION_ID`, `DISCORD_PUBLIC_KEY`, `DISCORD_GUILD_ID` | The app, and the server `npm run register` puts the commands in |
| `SITE_URL` | The website the bot reads (genjiball.us) |
| `SITE_TIMEOUT_SECONDS` | How long a site request may take (1 to 30, 5 if missing; autocomplete waits at most 2) |
| `STAFF_ROLE_ID` | The Staff role |
| `TOURNEY_CHANNEL_ID` | Sign-up posts and lists |
| `RESULTS_CHANNEL_ID` | Tournament match results |
| `TOURNEY_RESULTS_CHANNEL_ID` | A finished tourney's picture |
| `RANKUP_CHANNEL_ID` | Rank-up posts |
| `RANK_ROLES`, `UNRANKED_ROLE_ID` | The rank roles, lowest tier first, and the role below the first tier |
| `GOD_ROLE_IDS`, `DEMIGOD_ROLE_IDS` | The titles, `region=role id` |
| `TOURNEY_REFRESH_MINUTES`, `CONFIRM_MINUTES`, `LEADERBOARD_REFRESH_MINUTES`, `RANK_REFRESH_MINUTES` | Minutes (1 to 60, 5 if missing) |

Secrets: `DISCORD_TOKEN` and `SITE_TOKEN` (optional). Bindings: `DB` (D1) and `BROWSER`.

The cron runs every minute and does the work above on its own schedule. The Worker also answers `POST /interactions` (Discord), `GET /titles` (who has a title, for genjiball.us) and `GET /` (a status line).

The database (`migrations/`): `tournaments`, `entrants`, `dm_channels` (DM channel per user), `boards` (live leaderboards), `bot_state` (where the match feed and rank check are), `result_posts` (match result posts), `links` (`/gr link`) and `titles` (God and Demigod at the last rank check).

## Good to know

- **Limits:** the free Cloudflare plan allows about 45 Discord requests a minute, so the bot sends about 20 Confirm DMs a minute: 100 within the 5 minutes.
- **Fewer reads on the site:** player searches, profiles and the leaderboard are kept for a minute; the live boards share one drawing; the rank check only reads the tiers again when a match was rated (or hourly).
- **Where everything comes from:** genjiball.us's public API. The only thing the bot changes there is the tourney sign-ups (with `SITE_TOKEN`).
- `npm test` runs the tests (Node 22.5 or newer).
- Working on the code? Read [AGENTS.md](AGENTS.md), and open a PR with the template: CI runs `npm test` on it.
