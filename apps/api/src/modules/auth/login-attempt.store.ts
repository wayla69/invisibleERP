import { Inject, Injectable } from '@nestjs/common';
import { PG_CLIENT, type PgClient } from '../../database/database.module';

// ITGC-AC-07 — per-account login throttle/lockout.
// All statements run on the RAW pg client (AUTOCOMMIT), NOT the per-request tenant transaction: a failed
// login throws 401, which rolls back the request tx — so a counter written inside it would never accumulate.
// `login_attempts` is an auth-global (non-RLS) table, so the raw connection role can read/write it directly.
const THRESHOLD = Number(process.env.LOGIN_LOCK_THRESHOLD ?? 10); // consecutive fails before lockout
const LOCK_MINUTES = Number(process.env.LOGIN_LOCK_MINUTES ?? 15); // lockout duration
const WINDOW_MINUTES = Number(process.env.LOGIN_FAIL_WINDOW_MIN ?? 15); // idle gap that resets the counter

@Injectable()
export class LoginAttemptStore {
  constructor(@Inject(PG_CLIENT) private readonly sql: PgClient) {}

  // Seconds remaining on an active lockout, or 0 if the account may attempt to authenticate.
  async retryAfterSeconds(username: string): Promise<number> {
    try {
      const rows = await this.sql<{ secs: number }[]>`
        SELECT ceil(extract(epoch FROM (locked_until - now())))::int AS secs
        FROM login_attempts WHERE username = ${username} AND locked_until IS NOT NULL AND locked_until > now()`;
      return rows.length ? Math.max(1, Number(rows[0].secs)) : 0;
    } catch {
      return 0; // never block login because the lockout store is unavailable (fail open on infra error)
    }
  }

  // Record a failed attempt. Resets the counter if the prior attempt was outside the window; sets a lockout
  // once the running count reaches THRESHOLD. The increment + lock decision happen in one atomic UPSERT.
  async recordFailure(username: string): Promise<void> {
    try {
      await this.sql`
        INSERT INTO login_attempts (username, fail_count, last_attempt)
        VALUES (${username}, 1, now())
        ON CONFLICT (username) DO UPDATE SET
          fail_count = CASE WHEN login_attempts.last_attempt < now() - (${WINDOW_MINUTES} || ' minutes')::interval
                            THEN 1 ELSE login_attempts.fail_count + 1 END,
          last_attempt = now(),
          locked_until = CASE WHEN (CASE WHEN login_attempts.last_attempt < now() - (${WINDOW_MINUTES} || ' minutes')::interval
                                         THEN 1 ELSE login_attempts.fail_count + 1 END) >= ${THRESHOLD}
                              THEN now() + (${LOCK_MINUTES} || ' minutes')::interval
                              ELSE login_attempts.locked_until END`;
    } catch { /* best-effort: a counter write failure must not break the auth path */ }
  }

  // Clear on successful authentication.
  async clear(username: string): Promise<void> {
    try { await this.sql`DELETE FROM login_attempts WHERE username = ${username}`; } catch { /* best-effort */ }
  }
}
