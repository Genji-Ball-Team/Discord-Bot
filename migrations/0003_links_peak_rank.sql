-- The highest rank each linked member has had since they were linked, so a rank-up is posted once:
-- climbing back to a rank they already reached (or had when linked) isn't posted again. Seeded from
-- their rank now, so nobody gets a post for a rank they already have.
ALTER TABLE links ADD COLUMN peak_rank TEXT;
UPDATE links SET peak_rank = rank;
