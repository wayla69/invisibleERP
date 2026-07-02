import { pgTable, bigserial, bigint, text, numeric, index } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

// GL period-balance snapshot (docs/24 R1-2 / AUD-ARC-02) — Σdebit/Σcredit per (tenant, ledger, period,
// cost-center, account) over POSTED entries only. Maintained transactionally by LedgerService at the two
// balance-affecting transitions (postEntry→Posted, approveEntry Draft→Posted); Posted entries are
// DB-immutable (0165) so no other mutation can drift it — verified anyway at close (GL-20).
// Key columns are normalized NON-NULL ('' = NULL ledger/cost-center); the unique key lives in migration
// 0212 as an expression index (coalesce(tenant_id,0), …) because tenant_id stays nullable like
// journal_entries.
export const glPeriodBalances = pgTable(
  'gl_period_balances',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
    ledgerCode: text('ledger_code').notNull().default(''),
    period: text('period').notNull().default(''),
    costCenterCode: text('cost_center_code').notNull().default(''),
    accountCode: text('account_code').notNull(),
    debit: numeric('debit', { precision: 18, scale: 4 }).notNull().default('0'),
    credit: numeric('credit', { precision: 18, scale: 4 }).notNull().default('0'),
  },
  (t) => ({ byTenant: index('idx_gl_period_balances_tenant').on(t.tenantId) }),
);
