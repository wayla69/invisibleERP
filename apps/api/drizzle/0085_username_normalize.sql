-- Username normalization (login hardening).
-- Login matched usernames exactly (case- and whitespace-sensitive), so an account stored as "JohnD" or
-- "alice " could not be reached by typing "johnd"/"alice". Application code now canonicalizes usernames to
-- trimmed-lowercase on every write and read; this migration brings EXISTING rows in line so they keep
-- matching after the change.
--
-- Safe by construction: a row is only rewritten when its normalized form is not already taken by a
-- different user, so this can never violate the unique(username) constraint. Any row left un-normalized
-- (because lowercasing it would collide with another account) is reported via a NOTICE for manual cleanup.
DO $$
DECLARE skipped int;
BEGIN
  UPDATE users u
  SET username = lower(btrim(u.username))
  WHERE u.username <> lower(btrim(u.username))
    AND NOT EXISTS (
      SELECT 1 FROM users x
      WHERE x.id <> u.id AND x.username = lower(btrim(u.username))
    );

  SELECT count(*) INTO skipped
  FROM users u
  WHERE u.username <> lower(btrim(u.username));

  IF skipped > 0 THEN
    RAISE NOTICE 'username normalization: % row(s) left as-is to avoid a case-insensitive collision; resolve manually', skipped;
  END IF;
END $$;

-- Login now matches case-insensitively (lower(username) = <input>); keep that lookup index-backed.
CREATE INDEX IF NOT EXISTS users_username_lower_idx ON users (lower(username));
