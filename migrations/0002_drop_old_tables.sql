-- Leftovers from an older version of the bot that production still has: nothing reads them, and both
-- were empty when this was written (2026-10-23). IF EXISTS: a database built from 0001 never had them.
DROP INDEX IF EXISTS tourneys_due;
DROP TABLE IF EXISTS tourneys;
DROP TABLE IF EXISTS reminders;
