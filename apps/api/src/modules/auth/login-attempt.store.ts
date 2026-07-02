import { Inject, Injectable } from '@nestjs/common';
import { PG_CLIENT, type PgClient } from '../../database/database.module';
import { captureOpsAlert } from '../../observability/instrumentation';

// ITGC-AC-07 — per-account login throttle/lockout.
// All statements run on the RAW pg client (AUTOCOMMIT), NOT the per-request tenant transaction: a failed
// login throws 401, which rolls back the request tx — so a counter written inside it would never accumulate.
// `login_attempts` is an auth-global (non-RLS) table, so the raw connection role can read/write it directly.
const THRESHOLD = Number(process.env.LOGIN_LOCK_THRESHOLD ?? 10); // consecutive fails before lockout
const LOCK_MINUTES = Number(process.env.LOGIN_LOCK_MINUTES ?? 15); // lockout duration
const WINDOW_MINUTES = Number(process.env.LOGIN_FAIL_WINDOW_MIN ?? 15); // idle gap that resets the counter

// docs/27 R2-1 / AUD-SEC-01 — the store deliberately FAILS OPEN (login availability > lockout), but the
// degradation must be LOUD: while the store is unreachable, per-account brute-force protection is off and
// only the per-IP edge limiter remains. Alert ops (throttled — a down DB must not emit one alert per
// login attempt) so the fail-open window is short and visible, not silent.
let lastStoreAlertAt = 0;
function alertStoreUnavailable(op: string, err: unknown): void {
  const now = Date.now();
  if (now - lastStoreAlertAt < 60_000) return;
  lastStoreAlertAt = now;
  captureOpsAlert('login_lockout_store_unavailable', { op, degraded: 'per-account lockout FAIL-OPEN (ITGC-AC-07); per-IP edge limiter still active' }, err);
}

@Injectable()
export class LoginAttemptStore {
  constructor(@Inject(PG_CLIENT) private readonly sql: PgClient) {}

  // Seconds remaining on an active lockout, or 0 if the account may attempt to authenticate.
  async retryAfterSeconds(username: string): Promise<number> {
    try {
      const rows = await this.sql<{ secs: number }[]>`
        SELECT ceil(extract(epoch FROM (locked_until - now())))::int AS secs
        FROM login_attempts WHERE username = ${username} AND locked_until IS NOT NULL AND locked_until > now()`;
      return rows.length ? Math.max(1, Number(rows[0]!.secs)) : 0;
    } catch (e) {
      alertStoreUnavailable('retryAfterSeconds', e);
      return 0; // never block login because the lockout store is unavailable (fail open on infra error)
    }
  }

  // Record a failed attempt. Resets the counter if the prior attempt was outside the window; sets a lockout
  // once the running count reaches THRESHOLD. The increment + lock decision happen in one atomic UPSERT.
  async recordFailure(username: string): Promise<void> {
    try {
      const rows = await this.sql<{ fail_count: number; locked_until: Date | null }[]>`
        INSERT INTO login_attempts (username, fail_count, last_attempt)
        VALUES (${username}, 1, now())
        ON CONFLICT (username) DO UPDATE SET
          fail_count = CASE WHEN login_attempts.last_attempt < now() - (${WINDOW_MINUTES} || ' minutes')::interval
                            THEN 1 ELSE login_attempts.fail_count + 1 END,
          last_attempt = now(),
          locked_until = CASE WHEN (CASE WHEN login_attempts.last_attempt < now() - (${WINDOW_MINUTES} || ' minutes')::interval
                                         THEN 1 ELSE login_attempts.fail_count + 1 END) >= ${THRESHOLD}
                              THEN now() + (${LOCK_MINUTES} || ' minutes')::interval
                              ELSE login_attempts.locked_until END
        RETURNING fail_count, locked_until`;
      // ITGC-AC-07 — alert ops when an account LOCKS. recordFailure runs only when the account is NOT
      // already locked (the auth path checks retryAfterSeconds first), so a result at/over THRESHOLD with a
      // future lock IS the lock transition — a brute-force / credential-stuffing signal worth paging on.
      const r = rows[0];
      if (r && Number(r.fail_count) >= THRESHOLD && r.locked_until) {
        captureOpsAlert('login_lockout', { username, fail_count: Number(r.fail_count), lock_minutes: LOCK_MINUTES });
      }
    } catch (e) { alertStoreUnavailable('recordFailure', e); /* best-effort: a counter write failure must not break the auth path */ }
  }

  // Clear on successful authentication.
  async clear(username: string): Promise<void> {
    try { await this.sql`DELETE FROM login_attempts WHERE username = ${username}`; } catch (e) { alertStoreUnavailable('clear', e); /* best-effort */ }
  }
}
