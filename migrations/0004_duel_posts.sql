-- Duels (1v1s staff enter on the site) posted in DUELS_CHANNEL_ID: one row per duel, with the line
-- that shows it and the message it's in. Several duels saved together share one message; a voided
-- duel's line is taken out of it (the message is deleted when none is left).
CREATE TABLE duel_posts (
  duel_id INTEGER PRIMARY KEY,
  region TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  line TEXT NOT NULL
);
CREATE INDEX duel_posts_message ON duel_posts(message_id);
