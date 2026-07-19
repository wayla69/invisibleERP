-- 0428_scrub_legacy_sha256_password_hashes — SOX-ICFR audit finding 4.5-bis (legacy password migration risk).
-- The pre-V2 unsalted SHA-256 password hashes (a bare 64-hex value inherited from the V1 user_store) are
-- ALREADY rejected at login (auth PasswordService.verify short-circuits them → an admin reset is required).
-- But the crackable material still sat in the `users.password_hash` column: unsalted SHA-256 is recovered at
-- billions of guesses/sec, so a DB-only leak (dump / replica / backup) hands an attacker the plaintext of
-- every reused password. This migration removes that material from the database and flags the affected
-- accounts for admin-driven reset. It is idempotent (a second run matches no rows) and safe on a DB that has
-- no such rows (the expected steady state).
--
-- The sentinel value is un-verifiable by every code path (not 64-hex; splits to a single non-'scrypt' token),
-- so it can never authenticate — equivalent to a disabled credential pending reset.
UPDATE users
   SET password_hash = 'disabled:legacy-sha256-scrubbed',
       must_change_password = true
 WHERE password_hash ~ '^[a-f0-9]{64}$';
