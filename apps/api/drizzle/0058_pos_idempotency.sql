-- C1: payment idempotency. A retried/duplicated POST /api/payments carrying the same idempotency_key
-- must NOT capture funds twice. The column stores the client token; the UNIQUE index is the race
-- backstop so two concurrent retries collapse to one row (the loser hits ON CONFLICT DO NOTHING).
-- NULL keys are allowed many times over (Postgres null-distinct) so keyless/legacy tenders are unaffected.
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "idempotency_key" text;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ux_payments_idem" ON "payments" ("idempotency_key");
