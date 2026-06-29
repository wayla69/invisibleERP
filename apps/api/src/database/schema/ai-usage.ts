import { pgTable, bigserial, bigint, integer, date, timestamp } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

// Per-tenant daily AI token usage (ITGC-SEC-AI-01 — budget enforcement + cost attribution).
// Written via the AUTOCOMMIT PG_CLIENT so usage persists even when the request transaction rolls back.
export const aiTokenUsage = pgTable('ai_token_usage', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull().references(() => tenants.id),
  usageDate: date('usage_date').notNull(), // business date in Asia/Bangkok (UTC+7)
  inputTokens: integer('input_tokens').notNull().default(0),
  outputTokens: integer('output_tokens').notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
});
