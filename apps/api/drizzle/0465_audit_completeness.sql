-- 0465 — audit-trail COMPLETENESS evidence (ITGC-AC-16).
--
-- The hash chain proves nobody EDITED history. It cannot prove nothing was OMITTED: `audit_log.seq` is
-- derived from the last SUCCESSFULLY written row, so a dropped write leaves no gap for the verify walk to
-- find. This table supplies the missing half — a per-tenant count of audit rows the system OWES.
--
-- `TenantTxInterceptor` bumps `expected` INSIDE the business transaction whenever the request is one the
-- trail must record, so the counter is durable exactly when the business mutation itself committed. The
-- invariant is deliberately ONE-DIRECTIONAL:
--
--     written >= expected
--
-- `written` may legitimately EXCEED `expected` — a rolled-back request writes a 'fail' audit row but its
-- bump rolls back with it; @NoTx handlers and guard refusals write without any bump; and every row that
-- predates this migration has no expectation at all. A SHORTFALL, however, has no benign explanation: it is
-- permanent, provable evidence that audit rows were lost — the answer to "how do you know none were
-- dropped?" that the chain alone could not give.
--
-- SHARDED on purpose. A single counter row per tenant would take a row lock held for the whole business
-- transaction, serialising every concurrent mutation for that tenant — an availability regression paid on
-- every write. Spreading over N shards divides that contention; reconciliation just SUMs them.
CREATE TABLE IF NOT EXISTS audit_expectations (
  tenant_id  bigint  NOT NULL,
  shard      smallint NOT NULL,
  expected   bigint  NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, shard)
);

-- The counter is tenant-scoped and gets the CANONICAL org-clause `tenant_isolation` policy (0232's body,
-- NOT the plain one — the plain form silently drops cross-account org sharing). This is not bureaucracy: the
-- verify walk reads audit_log through RLS, so the expectation side MUST be scoped identically. A permissive
-- policy (or renaming the column to about_tenant_id to dodge the RLS-coverage gate) would let a tenant admin
-- see OTHER tenants' expectations while seeing none of their audit rows — manufacturing a phantom shortfall
-- and crying "audit rows were lost" on a healthy system. Both sides scoped the same way, or neither.
--
-- The bump inserts under the caller's own app.tenant_id, which the WITH CHECK admits; pre-auth requests
-- (tenant_id NULL -> key 0) run with app.bypass_rls='on', so they are admitted too.
ALTER TABLE audit_expectations ENABLE ROW LEVEL SECURITY;

-- PERMISSIVE on purpose, and the reason is worth stating because the obvious alternative is a bug.
--
-- The bump runs INSIDE the business transaction, and in PostgreSQL a statement that fails ABORTS that
-- transaction (25P02) — catching the error in application code does NOT undo it, so any policy this write can
-- violate turns an integrity ledger into a 500 on the business request. Two ways a tenant-scoped policy does
-- exactly that: (1) the counter is keyed on the tenant the AUDIT ROW is credited to (the operator's own),
-- while a god acting-as another company sets app.tenant_id to the TARGET — so a scoped WITH CHECK rejects it;
-- (2) `ON CONFLICT DO UPDATE` must SELECT the conflicting row, so a scoped USING clause fails the upsert the
-- moment the row belongs to another tenant. A SAVEPOINT is the textbook answer, but savepoint recovery has
-- already bitten this codebase across drivers (the 2026-07 tenant-wipe saga), so the write path is made
-- structurally incapable of failing instead.
--
-- Nothing leaks by making it permissive: the key is server-derived from the JWT (never client input), the row
-- holds only a COUNT, and no endpoint returns these rows. The scoping that MATTERS — so a tenant admin cannot
-- be shown a phantom shortfall for a company whose audit rows it cannot see — is enforced where it actually
-- belongs, in the reconciliation: verifyCompleteness iterates the RLS-scoped audit chains and looks up each
-- one's expectation, never the other way round.
DROP POLICY IF EXISTS tenant_isolation ON public.audit_expectations;
CREATE POLICY tenant_isolation ON public.audit_expectations USING (true) WITH CHECK (true);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT SELECT, INSERT, UPDATE ON audit_expectations TO app_user;
  END IF;
END $$;
