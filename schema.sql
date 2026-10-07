-- The bot's own database (D1 "genjiball-discord-bot"). Safe to run again: it only adds what's missing.
--   npm run db:setup

-- The site's tourneys the bot has posted. `id` is the tourney's id on genjiball.us.
CREATE TABLE IF NOT EXISTS tournaments (
  id INTEGER PRIMARY KEY,
  region TEXT NOT NULL,                -- 'eu' or 'na'
  name TEXT NOT NULL,
  starts_at INTEGER NOT NULL,          -- unix seconds
  channel_id TEXT NOT NULL,            -- the sign-ups channel
  message_id TEXT,                     -- the sign-up post (deleted at the start)
  phase TEXT NOT NULL,                 -- open → confirming → started, or cancelled
  list_message_id TEXT,                -- the list of confirmed players
  results_message_id TEXT,             -- the standings, once the site has them
  created_by TEXT NOT NULL,            -- 'site' (kept for older rows)
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS tournaments_phase ON tournaments (phase, starts_at);

-- Who registered. `confirmed`: pressed Confirm in the DM, or registered during the confirm minutes.
CREATE TABLE IF NOT EXISTS entrants (
  tournament_id INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,                  -- their server name when they registered
  registered_at INTEGER NOT NULL,      -- ms
  confirmed INTEGER NOT NULL DEFAULT 0,
  dm_status TEXT NOT NULL DEFAULT 'none', -- none, pending, sent, failed (DMs closed)
  PRIMARY KEY (tournament_id, user_id)
);
CREATE INDEX IF NOT EXISTS entrants_dm ON entrants (tournament_id, dm_status);

-- DM channel per user, so a DM costs one Discord request instead of two.
CREATE TABLE IF NOT EXISTS dm_channels (
  user_id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL
);

-- Live leaderboards (/gr setup leaderboard): one message per channel, kept up to date by the cron.
CREATE TABLE IF NOT EXISTS boards (
  channel_id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  message_id TEXT NOT NULL UNIQUE,
  refreshed_at INTEGER NOT NULL DEFAULT 0
);

-- Small settings the bot keeps between runs, like where it is in the site's match feed.
CREATE TABLE IF NOT EXISTS bot_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Tournament results posted in RESULTS_CHANNEL_ID, one per match. `shown`: what the post shows,
-- so it's only edited when that changes.
CREATE TABLE IF NOT EXISTS result_posts (
  match_id INTEGER PRIMARY KEY,
  channel_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  shown TEXT NOT NULL
);
