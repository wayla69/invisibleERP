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

// W4 — shift schedule / roster. A planned shift for a staff member; the labor summary sums scheduled hours
// × rate and compares it to sales (labor % of sales) and to actual punched hours (time_clock). Operational
// scheduling — no GL.
export const shiftSchedules = pgTable('shift_schedules', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  empCode: text('emp_code').notNull(),
  shiftDate: text('shift_date').notNull(),                  // YYYY-MM-DD
  startTime: text('start_time').notNull(),                  // HH:MM
  endTime: text('end_time').notNull(),                      // HH:MM
  hours: numeric('hours', { precision: 8, scale: 2 }).notNull().default('0'),
  hourlyRate: numeric('hourly_rate', { precision: 12, scale: 2 }).notNull().default('0'),
  position: text('position'),
  status: text('status').notNull().default('scheduled'),    // scheduled | published | cancelled
  notes: text('notes'),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});
