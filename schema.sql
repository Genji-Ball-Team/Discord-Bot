-- Run once: npx wrangler d1 execute genjiball-discord-bot --remote --file=schema.sql

-- genjiball.us's tourneys the bot announced in TOURNEY_CHANNEL_ID, as last read from the site.
CREATE TABLE IF NOT EXISTS tourneys (
  id INTEGER PRIMARY KEY,            -- the site's tourney id
  region TEXT NOT NULL,              -- 'eu' or 'na'
  name TEXT NOT NULL,
  starts_at INTEGER NOT NULL,        -- unix seconds
  status TEXT NOT NULL,              -- the site's: scheduled, live, done, cancelled
  channel_id TEXT NOT NULL,
  message_id TEXT NOT NULL,          -- the announcement
  shown TEXT NOT NULL,               -- what the announcement shows, so it's only edited on a change
  results_message_id TEXT,           -- the standings, once it's done
  results_shown TEXT,
  reminded INTEGER NOT NULL DEFAULT 0 -- 1 once the reminder DMs are done
);
CREATE INDEX IF NOT EXISTS tourneys_due ON tourneys (reminded, starts_at);

-- Who pressed 🔔 Remind me, where, and whether their DM went out.
CREATE TABLE IF NOT EXISTS reminders (
  tourney_id INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,          -- for the "couldn't DM" note
  dm_status TEXT NOT NULL DEFAULT 'pending', -- pending, sent, failed
  PRIMARY KEY (tourney_id, user_id)
);

-- DM channel per user, so a DM costs one Discord request instead of two.
CREATE TABLE IF NOT EXISTS dm_channels (
  user_id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL
);

-- Live leaderboards (/setup leaderboard): one message per channel, kept up to date by the cron.
CREATE TABLE IF NOT EXISTS boards (
  channel_id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  message_id TEXT NOT NULL UNIQUE,
  refreshed_at INTEGER NOT NULL DEFAULT 0
);
