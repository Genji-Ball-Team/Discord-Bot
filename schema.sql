-- Run once: npx wrangler d1 execute genjiball-discord-bot --remote --file=schema.sql

-- Tournament sign-up posts made with /host tournament.
CREATE TABLE IF NOT EXISTS tournaments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  message_id TEXT,
  region TEXT NOT NULL,              -- 'eu' or 'na'
  name TEXT NOT NULL,
  starts_at INTEGER NOT NULL,        -- unix seconds
  created_by TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open', -- open → reminding → done, or cancelled
  list_message_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS tournaments_due ON tournaments (status, starts_at);

-- Who signed up (read from the reactions when sign-ups close) and whether their DM went out.
CREATE TABLE IF NOT EXISTS signups (
  tournament_id INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  dm_status TEXT NOT NULL DEFAULT 'pending', -- pending, sent, failed
  PRIMARY KEY (tournament_id, user_id)
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
