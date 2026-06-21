// Accounting Tier 3 batch 3 — Multi-ledger / Multi-GAAP (สมุดบัญชีหลายเล่ม / หลายมาตรฐาน).
// Parallel sets of books under different accounting standards. Global config (like accounts/COA), no
// tenant_id. A journal entry with ledger_code = NULL is SHARED (every ledger sees it); a specific code
// is a GAAP-divergent adjustment posted to ONE ledger only. A ledger's books = (NULL OR = its code).
import { pgTable, bigserial, text, boolean } from 'drizzle-orm/pg-core';

export const ledgers = pgTable('ledgers', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  code: text('code').notNull().unique(),          // TFRS | TAX | IFRS
  name: text('name').notNull(),
  gaap: text('gaap').notNull(),                    // TFRS | TAX | IFRS — the standard this ledger represents
  isLeading: boolean('is_leading').default(false), // the statutory/primary book (default for reports)
  currency: text('currency').default('THB'),
  description: text('description'),
  active: boolean('active').default(true),
});

export type Ledger = typeof ledgers.$inferSelect;
