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
  // Step 9 — clock-in integrity (anti-buddy-punch): how the punch was made, where, and whether it passed
  // the branch geofence (null = no GPS supplied / no zone configured).
  clockInMethod: text('clock_in_method').notNull().default('PIN'),  // PIN | QR | FACE_HASH | SUPERVISOR
  clockInLat: numeric('clock_in_lat', { precision: 9, scale: 6 }),
  clockInLng: numeric('clock_in_lng', { precision: 9, scale: 6 }),
  geofencePass: boolean('geofence_pass'),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

// Step 9 — per-branch geofence: a punch is expected within radius_m of (lat,lng). When a zone is configured
// and GPS is supplied, the clock-in computes geofence_pass; out-of-fence punches are flagged for review.
export const geofenceZones = pgTable('geofence_zones', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  branchId: bigint('branch_id', { mode: 'number' }),
  lat: numeric('lat', { precision: 9, scale: 6 }).notNull(),
  lng: numeric('lng', { precision: 9, scale: 6 }).notNull(),
  radiusM: integer('radius_m').notNull().default(150),
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

// Step 8 — tiered overtime rules (Thai LPA): a per-tenant override of the multiplier + daily/weekly trigger
// hours per rule type. The service falls back to the statutory defaults (REGULAR_OT 1.5×, HOLIDAY 2×,
// HOLIDAY_OT 3×, NIGHT 1.0×; 8h/day, 48h/week) when a tenant has no override.
export const laborOtRules = pgTable('labor_ot_rules', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  ruleType: text('rule_type').notNull(),                    // REGULAR_OT | HOLIDAY | HOLIDAY_OT | NIGHT
  multiplier: numeric('multiplier', { precision: 4, scale: 2 }).notNull().default('1.5'),
  dailyTriggerHours: integer('daily_trigger_hours').notNull().default(8),
  weeklyTriggerHours: integer('weekly_trigger_hours').notNull().default(48),
  effectiveFrom: text('effective_from'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

// Step 8 — labor-% alerts: when scheduled labor cost exceeds a target % of sales for a period, an alert is
// raised so the manager can act (cut a shift, push sales). Operational — no GL.
export const laborAlerts = pgTable('labor_alerts', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  branchId: bigint('branch_id', { mode: 'number' }),
  periodFrom: text('period_from'),
  periodTo: text('period_to'),
  alertType: text('alert_type').notNull(),                  // LABOR_PCT_EXCEEDED | OT_CAP_APPROACHING | SCHEDULE_GAP
  thresholdPct: numeric('threshold_pct', { precision: 7, scale: 4 }),
  actualPct: numeric('actual_pct', { precision: 7, scale: 4 }),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});
