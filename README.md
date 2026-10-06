# Genji Ball Discord bot

A Discord bot for the Genji Ball Ranked server. It runs on Cloudflare Workers, like genjiball.us, so nothing has to stay running on your PC.

## What it does

| Command | Who | What |
|---|---|---|
| `/setup leaderboard [channel]` | Staff | Posts the **live leaderboard** in a channel: EU top 15, updated every 5 minutes. Its **EU / NA** and **◀ Prev / Next ▶** buttons (up to page 5, top 75) open a private copy for whoever presses them, so the channel's board stays the same for everyone. Run it again to refresh it; delete the message to stop it. |
| `/leaderboard [region] [page]` | Staff | Posts a one-off leaderboard anywhere. Its buttons flip that message. |
| `/stats player [region]` | Everyone | A player's rating, tier, rank, rounds, win %, kills, deflects, peak, streaks and recent form. Names autocomplete as you type. |
| `/host tournament region day [time] [name]` | Staff | Posts a sign-up with the region's role pinged (@EU or @NA). Players react ✅. The start time shows in **each reader's own time zone**. Default time: EU 21:00 Moscow, NA 21:00 New York. |
| `/host cancel region` | Staff | Cancels the next tournament in that region. |

**5 minutes before a tournament** the bot closes sign-ups, posts the numbered list of who signed up under the sign-up message, and DMs every one of them that it's starting (with how to find the lobby). Anyone with DMs closed is named in the channel instead, so they still get a ping.

"Staff" means anyone with your **Staff** role (`STAFF_ROLE_ID` in `wrangler.toml`), plus server admins so the owner can never lock themselves out. Anyone else gets a private "Only Staff can use this" reply. Everyone can press the leaderboard's buttons.

Discord still *lists* the staff commands for everyone. To hide them from non-staff too: Server Settings → Integrations → the bot → for `/host`, `/setup` and `/leaderboard`, turn off **@everyone** and add **Staff**.

**Tip for the leaderboard channel:** make it read-only for members (no Send Messages) so the board stays the only thing in it. The bot still needs View Channel, Send Messages and Embed Links there.

## Setup (about 20 minutes, once)

You need: a Discord server you manage, the Genji Ball Cloudflare account, the one genjiball.us is on (check with `npx wrangler whoami`; never a personal account), and [Node.js](https://nodejs.org) (the LTS version) on your PC.

### 1. Make the Discord app

1. Go to <https://discord.com/developers/applications> → **New Application** → name it (e.g. *Genji Ball*).
2. On **General Information**, copy the **Application ID** and **Public Key**.
3. On **Bot**: click **Reset Token** and copy the token. Keep it secret: it's the bot's password.
4. Invite it to your server: open this link with your Application ID in it.

   `https://discord.com/oauth2/authorize?client_id=YOUR_APPLICATION_ID&scope=bot+applications.commands&permissions=216128`

   That asks for: View Channels, Send Messages, Embed Links, Add Reactions, Read Message History, and Mention All Roles (so it can ping @EU and @NA).

### 2. Fill in `wrangler.toml`

Open `wrangler.toml` in Notepad and paste in:

- `DISCORD_APPLICATION_ID` and `DISCORD_PUBLIC_KEY` from step 1.
- `STAFF_ROLE_ID`, `EU_ROLE_ID` and `NA_ROLE_ID`: in Discord, turn on Settings → Advanced → **Developer Mode**, then Server Settings → Roles → right-click the role → **Copy Role ID**.
- The times and time zones are already set to 21:00 Moscow (EU) and 21:00 New York (NA). Change them here if that ever changes.

### 3. Put it on Cloudflare

Open a terminal in this folder (in File Explorer: click the address bar, type `cmd`, press Enter) and run these one at a time:

```
npm install
npx wrangler login
npx wrangler d1 create genjiball-discord-bot
```

The last one prints a `database_id`. Paste it into `wrangler.toml` where it says `PASTE_DATABASE_ID_HERE`. Then:

```
npm run db:setup
npx wrangler secret put DISCORD_TOKEN
npm run deploy
```

`secret put` asks for the bot token from step 1. `deploy` prints the bot's address, like `https://genjiball-discord-bot.yourname.workers.dev`.

### 4. Connect Discord to it

1. Back in the Developer Portal, **General Information** → **Interactions Endpoint URL**: paste the address from step 3 with `/interactions` on the end, e.g. `https://genjiball-discord-bot.yourname.workers.dev/interactions`, and **Save**. Discord tests it right away; if it saves, it works.
2. Register the commands (same terminal, with your token and Application ID):

   ```
   set DISCORD_TOKEN=your-bot-token
   set DISCORD_APPLICATION_ID=your-application-id
   npm run register
   ```

   (In PowerShell instead of cmd: `$env:DISCORD_TOKEN="..."` and `$env:DISCORD_APPLICATION_ID="..."`.)

   They can take a few minutes to show up. To see them in your server instantly while testing, also `set DISCORD_GUILD_ID=your-server-id` before `npm run register`.

### 5. Try it

- `/setup leaderboard channel:#leaderboard`
- `/stats player:Fealthy`
- `/host tournament region:EU day:Saturday`

## Changing things later

- Edit the code or `wrangler.toml`, then `npm run deploy`. `LEADERBOARD_REFRESH_MINUTES` sets how often the live board updates.
- Changed `scripts/commands.js` (command names or options)? Also `npm run register`.
- `npm test` runs the tests (needs Node 22.5 or newer).
- Working on the code? Read [AGENTS.md](AGENTS.md), and open a PR with the template: CI runs `npm test` on it.

## Good to know

- **Sign-ups are read when they close.** Anyone who reacts and then removes the reaction before then isn't on the list; reactions after the list is posted don't count.
- **Big tournaments:** the free Cloudflare plan lets each minute's run make about 45 Discord requests, so the bot DMs about 20–40 people a minute. 70 sign-ups are all DMed within the 5 minutes.
- **Pings:** the sign-up list and the leaderboard never ping anyone. Only the sign-up post pings its role, and only the "couldn't DM" note pings the people named in it.
- **Where the numbers come from:** genjiball.us's public API (`/api/leaderboard`, `/api/players`, `/api/players/:id/stats` …). Nothing here can change the site.
