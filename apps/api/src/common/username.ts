// Username normalization — single source of truth for how a username is canonicalized before it is
// stored or looked up. Logins were case- and whitespace-sensitive (`eq(users.username, input)` with no
// trimming), so an account created as "JohnD " could never be reached by typing "johnd". We canonicalize
// to trimmed-lowercase at EVERY write (create/signup) and EVERY read (login + admin/portal lookups) so a
// username is matched consistently regardless of casing or stray surrounding whitespace.
//
// Note: only the *username* is normalized. Passwords are NEVER trimmed/changed — altering a secret would
// silently weaken it and break legitimate passwords that contain spaces.
export function normalizeUsername(username: string): string {
  return username.trim().toLowerCase();
}
