-- H4: structural ledger idempotency. The check-then-post in postEntry (via alreadyPosted) is not atomic,
-- and idx_je_source was a NON-unique index, so two concurrent identical postings could double-post the GL.
-- This UNIQUE index makes one posting per (tenant, source, source_ref, ledger) — the loser of a race hits
-- ON CONFLICT DO NOTHING. COALESCE folds NULL tenant/ledger to 0/'' so they still collide (plain NULLs are
-- distinct in a unique index, which would defeat the guard for exactly the automated NULL-ledger postings
-- we must protect). Partial: manual entries carry no source_ref and stay exempt (many allowed).
CREATE UNIQUE INDEX IF NOT EXISTS "ux_je_idem"
  ON "journal_entries" (coalesce("tenant_id", 0), "source", "source_ref", coalesce("ledger_code", ''))
  WHERE "source_ref" IS NOT NULL;
