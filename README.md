# Genji Ball Discord bot

The Discord bot for the Genji Ball Ranked server. It runs on Cloudflare Workers, like genjiball.us, so nothing has to stay running on your PC.

## Commands

Everything is under **`/gr`**.

| Command | Who | What |
|---|---|---|
| `/gr stats player [region]` | Everyone | A player's rating, tier, rank, rounds, win %, kills, deflects, peak, streaks and recent form. Names autocomplete. |
| `/gr leaderboard [region] [page]` | Staff | Posts a one-off leaderboard. Its buttons flip that message. |
| `/gr setup leaderboard [channel]` | Staff | Posts the **live leaderboard** (EU top 15, updated every 5 minutes, EU/NA and pages up to the top 75). Its buttons open a private copy, so the channel's board stays the same for everyone. |

"Staff" means the role in `STAFF_ROLE_ID`, plus server admins. Anyone else gets "Only Staff can use this".

## How a tournament runs

Admins make tourneys on **genjiball.us** (the admin page), with their lobbies and hosts, as before.

1. **The post.** Within `TOURNEY_REFRESH_MINUTES` (5) of a tourney being made on the site, the bot posts its sign-up in `TOURNEY_CHANNEL_ID`: name, start time in each reader's own time zone, region and the sign-up count, with **Register**, **Unregister** and **👥 Who's signed up**. It never pings anyone. Each button answers privately. **Register** asks for your in-game name (your server name filled in) and signs you up on the site too: see [One list with the site](#one-list-with-the-site).
2. **5 minutes before** (`CONFIRM_MINUTES`), everyone registered gets a DM: "⏰ Tournament starting in 5 minutes" with a **Confirm** button. Anyone who doesn't press it isn't playing. Register stays open, and registering now confirms at once. Players with DMs closed never get the button, so they're out.
3. **At the start**, the sign-up post is deleted and the list of confirmed players is posted as @mentions that notify nobody, ending "Hosts: split the lobbies from this list."
4. When an admin marks the tourney **done** on the site (with lobby standings), the bot posts the standings under the list.

Changes on the site follow within 5 minutes: a new name or start time updates the post (moved later during the 5 confirm minutes: back to sign-ups, and the DMs go out again before the new start), and a cancelled or deleted tourney's post is crossed out. Right before posting the list, the bot checks the site once more, so a last-minute move or cancel is caught too.

### One list with the site

With the `SITE_TOKEN` secret set, Discord and the tourney's page on genjiball.us share one sign-up list:

- **Register** signs you up on the site with the in-game name you type. A name someone already typed on the page with no Discord account is you: you take that sign-up. A name another Discord user has is refused.
- **Unregister** takes you off the site's list too.
- The post's count and **Who's signed up** are the site's: names typed on the page are counted and listed ("on the site"). A name typed on the page shows up on the post within 5 minutes.
- An admin who removes you on the site's admin page removes you here too: no Confirm DM, not on the list.
- Players who signed up only on the page can't get the Confirm DM. The list at the start names them apart, for the hosts.
- Registrations from before `SITE_TOKEN` was set are sent within 5 minutes, under the server name they registered with. One whose name another Discord user already has stays registered in Discord only.

Without `SITE_TOKEN` the bot keeps its own list, as before, and doesn't use the page's sign-ups.

## Tournament results

Every tournament match the site rates is posted in `RESULTS_CHANNEL_ID`, one post per lobby's match: the tourney and lobby, region, rounds and date, then each player ranked as in the standings (most wins, ties broken by kills) with their wins, kills and rating before → after with the change. No pings, no emojis, a red side line like the other posts.

The bot follows the site's match feed (checked every 5 minutes; the site rates every 10), so a result shows up about 10–15 minutes after the match is uploaded. A longer copy of the match edits the post, and a voided match's post is deleted. A later recompute of the ratings doesn't change a post that's already up. Matches from before the bot started following the feed are never posted.

## Deploying a change

Open a terminal in this folder (in File Explorer: click the address bar, type `cmd`, press Enter):

```
npm install
npm run deploy
```

Changed the commands (`scripts/commands.js`)? Also `npm run register`: it asks for the bot token and puts the commands in the Genji Ball server (`DISCORD_GUILD_ID`), where they show up at once.

First time only, or after adding a table to `schema.sql`: `npm run db:setup`, **before** `npm run deploy`, so the new tables are there when the new code runs.

Deploy only to the Genji Ball Cloudflare account, the one genjiball.us is on: check `npx wrangler whoami` first, never a personal account.

The bot token is a secret on Cloudflare, never in this repo: `npx wrangler secret put DISCORD_TOKEN`. So is the site's: `npx wrangler secret put SITE_TOKEN`, the same value as genjiball.us's `BOT_TOKEN` secret (in genjiball-ranked: `npx wrangler secret put BOT_TOKEN`).

## Setting it up from scratch

1. Discord Developer Portal → New Application. Copy the **Application ID** and **Public Key** into `wrangler.toml`. On **Bot**, Reset Token and keep it.
2. Invite it: `https://discord.com/oauth2/authorize?client_id=YOUR_APPLICATION_ID&scope=bot+applications.commands&permissions=19456` (View Channels, Send Messages and Embed Links. It only deletes its own posts, which needs nothing more).
3. `npx wrangler login`, `npx wrangler d1 create genjiball-discord-bot` (paste the id into `wrangler.toml`), `npm run db:setup`, `npx wrangler secret put DISCORD_TOKEN`, `npm run deploy`.
4. Developer Portal → General Information → **Interactions Endpoint URL**: the address `deploy` printed, plus `/interactions`. Save.
5. `npm run register`.

## Good to know

- **Limits:** the free Cloudflare plan allows about 45 Discord requests a minute, so the bot sends about 20 Confirm DMs a minute: 100 within the 5 minutes.
- **Where everything comes from:** genjiball.us's public API. The only thing the bot changes there is the tourney sign-ups (with `SITE_TOKEN`).
- `npm test` runs the tests (Node 22.5 or newer).
- Working on the code? Read [AGENTS.md](AGENTS.md), and open a PR with the template: CI runs `npm test` on it.
