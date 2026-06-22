import { pgTable, bigserial, bigint, text, numeric, integer, boolean, jsonb, timestamp } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';
import { employees } from './payroll';

// Delivery-aggregator config, one row per tenant+platform.
export const channelAdapters = pgTable('channel_adapters', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  platform: text('platform').notNull(), // grab | lineman | foodpanda | robinhood
  storeRef: text('store_ref'),
  enabled: boolean('enabled').default(true),
  autoAccept: boolean('auto_accept').default(true),
  config: jsonb('config'),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

// Loyalty tiers — earn/redeem multipliers gated by lifetime points.
export const loyaltyTiers = pgTable('loyalty_tiers', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  tier: text('tier').notNull(),
  minLifetime: numeric('min_lifetime', { precision: 14, scale: 2 }).default('0'),
  earnMult: numeric('earn_mult', { precision: 6, scale: 3 }).default('1'),
  redeemMult: numeric('redeem_mult', { precision: 6, scale: 3 }).default('1'),
  sort: integer('sort').default(0),
  active: boolean('active').default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

// Labor time & attendance.
export const timeClock = pgTable('time_clock', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  employeeId: bigint('employee_id', { mode: 'number' }).references(() => employees.id),
  empCode: text('emp_code'),
  clockIn: timestamp('clock_in', { withTimezone: true }),
  clockOut: timestamp('clock_out', { withTimezone: true }),
  breakMinutes: integer('break_minutes').default(0),
  hours: numeric('hours', { precision: 8, scale: 2 }),
  status: text('status').default('Open'), // Open | Closed
  note: text('note'),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});
