// Restaurant / F&B POS: kitchen stations + KDS, floor-plan tables + zones, table sessions
// (public QR diner sessions), dine-in orders + items (kitchen tickets). Every table carries
// tenant_id so the 0002 RLS loop (re-run in 0006) scopes them automatically.
import { pgTable, bigserial, bigint, text, numeric, integer, timestamp, boolean, jsonb } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';
import { dineInOrderStatusEnum, kdsItemStatusEnum, tableStatusEnum, tableSessionStatusEnum, orderChannelEnum, fulfillmentTypeEnum, fulfillmentStatusEnum, orderModeEnum, reservationStatusEnum } from './enums';
import { posMembers } from './loyalty-members';
import { buffetPackages } from './menu';

// ── Kitchen stations (ครัวร้อน / ครัวเย็น / เครื่องดื่ม) ──
export const kitchenStations = pgTable('kitchen_stations', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  code: text('code').notNull(),
  name: text('name').notNull(),
  sort: integer('sort').default(0),
  defaultPrepMinutes: integer('default_prep_minutes').default(10),
  active: boolean('active').default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

// ── โซน/พื้นที่ ──
export const floorZones = pgTable('floor_zones', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull().references(() => tenants.id),
  name: text('name').notNull(),
  sortOrder: integer('sort_order').default(0),
  // geometry: each zone is drawn as a positioned "room" rectangle on the floor plan (0085)
  posX: numeric('pos_x', { precision: 8, scale: 2 }).default('16'),
  posY: numeric('pos_y', { precision: 8, scale: 2 }).default('16'),
  width: numeric('width', { precision: 8, scale: 2 }).default('320'),
  height: numeric('height', { precision: 8, scale: 2 }).default('200'),
  color: text('color'),                      // optional accent (e.g. gold for a VIP room)
  active: boolean('active').default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

// ── โต๊ะ (layout staff-edited + runtime status) ──
export const diningTables = pgTable('dining_tables', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull().references(() => tenants.id),
  zoneId: bigint('zone_id', { mode: 'number' }).references(() => floorZones.id),
  tableNo: text('table_no').notNull(),
  seats: integer('seats').default(4),
  shape: text('shape').default('rect'),
  posX: numeric('pos_x', { precision: 8, scale: 2 }).default('0'),
  posY: numeric('pos_y', { precision: 8, scale: 2 }).default('0'),
  width: numeric('width', { precision: 8, scale: 2 }).default('80'),
  height: numeric('height', { precision: 8, scale: 2 }).default('80'),
  rotation: integer('rotation').default(0),
  status: tableStatusEnum('status').default('available'),
  qrToken: text('qr_token'),                 // stable opaque QR (identifies the table)
  active: boolean('active').default(true),
  rev: integer('rev').default(0),            // optimistic-lock version (P2a)
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
});

// ── เซสชันโต๊ะ (one seating; ties diner ↔ table ↔ order) ──
export const tableSessions = pgTable('table_sessions', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull().references(() => tenants.id),
  tableId: bigint('table_id', { mode: 'number' }).notNull().references(() => diningTables.id),
  sessionNo: text('session_no').notNull().unique(),     // TS-YYYYMMDD-NNN
  publicToken: text('public_token').notNull(),          // HMAC-signed diner credential (per session)
  status: tableSessionStatusEnum('status').default('open'),
  partySize: integer('party_size'),
  openedAt: timestamp('opened_at', { withTimezone: true }).defaultNow(),
  closedAt: timestamp('closed_at', { withTimezone: true }),
  openedBy: text('opened_by'),
  saleNo: text('sale_no'),
  notes: text('notes'),
  // ── buffet (Phase 2): a session runs in one mode; buffet fields set when a tier is started ──
  orderMode: orderModeEnum('order_mode').notNull().default('a_la_carte'),
  buffetPackageId: bigint('buffet_package_id', { mode: 'number' }).references(() => buffetPackages.id),
  pax: integer('pax'),
  buffetStartedAt: timestamp('buffet_started_at', { withTimezone: true }),
  buffetExpiresAt: timestamp('buffet_expires_at', { withTimezone: true }),
});

// ── ออเดอร์ทานที่ร้าน (kitchen ticket header) ──
export const dineInOrders = pgTable('dine_in_orders', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  orderNo: text('order_no').notNull().unique(),         // DIN-YYYYMMDD-NNN
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  tableId: bigint('table_id', { mode: 'number' }).references(() => diningTables.id),
  zoneId: bigint('zone_id', { mode: 'number' }),   // room snapshot taken at checkout — keeps per-room revenue accurate if the table later moves rooms (0088)
  sessionId: bigint('session_id', { mode: 'number' }).references(() => tableSessions.id),
  status: dineInOrderStatusEnum('status').notNull().default('open'),
  // online/delivery/kiosk dimension (POS Tier 2 #10) — legacy dine-in defaults keep existing rows unchanged
  channel: orderChannelEnum('channel').notNull().default('dine_in'),
  fulfillmentType: fulfillmentTypeEnum('fulfillment_type').notNull().default('dine_in'),
  fulfillmentStatus: fulfillmentStatusEnum('fulfillment_status'),  // NULL for dine-in (untouched)
  deliveryFee: numeric('delivery_fee', { precision: 14, scale: 2 }).notNull().default('0'),
  scheduledAt: timestamp('scheduled_at', { withTimezone: true }),
  publicToken: text('public_token'),                              // per-order HMAC tracking credential
  extSource: text('ext_source'),                                  // 'grab' | 'lineman'
  extOrderId: text('ext_order_id'),                               // partner order id (idempotency)
  memberId: bigint('member_id', { mode: 'number' }),              // pos_members FK — for loyalty earn on online orders
  guestCount: integer('guest_count').default(1),
  server: text('server'),
  subtotal: numeric('subtotal', { precision: 14, scale: 2 }).default('0'),
  vat: numeric('vat', { precision: 14, scale: 2 }).default('0'),
  total: numeric('total', { precision: 14, scale: 2 }).default('0'),
  saleNo: text('sale_no'),
  notes: text('notes'),
  openedAt: timestamp('opened_at', { withTimezone: true }).defaultNow(),
  firedAt: timestamp('fired_at', { withTimezone: true }),
  billRequestedAt: timestamp('bill_requested_at', { withTimezone: true }),
  paidAt: timestamp('paid_at', { withTimezone: true }),
  closedAt: timestamp('closed_at', { withTimezone: true }),
  rev: integer('rev').default(0),            // optimistic-lock version (P2a)
  createdBy: text('created_by'),
});

// ── รายการอาหาร (kitchen line) ──
export const dineInOrderItems = pgTable('dine_in_order_items', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  orderId: bigint('order_id', { mode: 'number' }).references(() => dineInOrders.id),
  stationId: bigint('station_id', { mode: 'number' }).references(() => kitchenStations.id),
  itemId: text('item_id'),
  name: text('name').notNull(),
  qty: numeric('qty').notNull().default('1'),
  unitPrice: numeric('unit_price', { precision: 14, scale: 2 }).notNull(),
  amount: numeric('amount', { precision: 14, scale: 2 }).notNull(),
  modifiers: jsonb('modifiers'),
  notes: text('notes'),
  isBuffet: boolean('is_buffet').notNull().default(false),  // buffet food line (priced ฿0, still hits KDS)
  buffetPackageId: bigint('buffet_package_id', { mode: 'number' }).references(() => buffetPackages.id), // tier this line belongs to (food + charge/overtime) → per-tier behaviour analytics
  course: integer('course').notNull().default(1),           // KDS course number — fired course-by-course
  seat: integer('seat'),                                     // seat-level ordering (POS-9): which guest seat ordered this line (NULL = shared/table); order/fire/split per seat
  kdsStatus: kdsItemStatusEnum('kds_status').notNull().default('new'),
  estPrepMinutes: integer('est_prep_minutes'),
  firedAt: timestamp('fired_at', { withTimezone: true }),
  startedAt: timestamp('started_at', { withTimezone: true }),
  readyAt: timestamp('ready_at', { withTimezone: true }),
  servedAt: timestamp('served_at', { withTimezone: true }),
  recallCount: integer('recall_count').notNull().default(0), // KDS bump/recall: times this line was recalled off the pass — feeds the all-day recall count per station (POS-4)
  voidedAt: timestamp('voided_at', { withTimezone: true }),
  voidReason: text('void_reason'),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
});

// 1:1 delivery details (only for delivery orders; keeps the order header lean)
export const orderDeliveryDetails = pgTable('order_delivery_details', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  orderId: bigint('order_id', { mode: 'number' }).notNull().references(() => dineInOrders.id),
  contactName: text('contact_name'),
  contactPhone: text('contact_phone'),
  addressLine: text('address_line'),
  addressNote: text('address_note'),
  lat: numeric('lat', { precision: 10, scale: 6 }),
  lng: numeric('lng', { precision: 10, scale: 6 }),
  courierName: text('courier_name'),
  courierPhone: text('courier_phone'),
  dispatchedAt: timestamp('dispatched_at', { withTimezone: true }),
  deliveredAt: timestamp('delivered_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

// raw inbound webhook log — audit + replay-safe idempotency at the edge
export const channelWebhookEvents = pgTable('channel_webhook_events', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  source: text('source').notNull(),            // 'grab' | 'lineman'
  extEventId: text('ext_event_id').notNull(),  // partner event id (idempotency key)
  extOrderId: text('ext_order_id'),
  orderNo: text('order_no'),                   // internal DIN- once mapped
  payload: jsonb('payload').notNull(),
  status: text('status').notNull().default('processed'), // processed | duplicate | error
  receivedAt: timestamp('received_at', { withTimezone: true }).defaultNow(),
});

// ── Reservations + walk-in waitlist (B1) ──
// One table covers both: a future booking (kind='reservation', reserved_for set) and a walk-in queue
// entry (kind='waitlist', reserved_for null). Both notify the guest (LINE/SMS) when ready and seat to a
// table. tenant_id → the RLS loop scopes it.
export const tableReservations = pgTable('table_reservations', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull().references(() => tenants.id),
  kind: text('kind').notNull().default('reservation'),    // 'reservation' | 'waitlist'
  tableId: bigint('table_id', { mode: 'number' }).references(() => diningTables.id), // optional assigned table
  reservedFor: timestamp('reserved_for', { withTimezone: true }), // booking time (null for walk-in waitlist)
  partySize: integer('party_size').notNull().default(2),
  // fine-casual: one venue seats both buffet and à-la-carte parties — the desk books the mode up front
  // (buffet may pre-pick a tier; the session's buffet clock still starts at the table, not here)
  serviceMode: orderModeEnum('service_mode').notNull().default('a_la_carte'),
  buffetPackageId: bigint('buffet_package_id', { mode: 'number' }).references(() => buffetPackages.id),
  occasion: text('occasion'),                             // birthday / anniversary / business — service prep
  customerName: text('customer_name'),
  customerPhone: text('customer_phone'),
  memberId: bigint('member_id', { mode: 'number' }).references(() => posMembers.id), // optional loyalty link
  status: reservationStatusEnum('status').notNull().default('booked'),
  quotedWaitMin: integer('quoted_wait_min'),              // waitlist: estimated wait at quote time
  notes: text('notes'),
  notifiedAt: timestamp('notified_at', { withTimezone: true }), // when the "table ready" message was sent
  seatedAt: timestamp('seated_at', { withTimezone: true }),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
});

// ── Tip pooling / distribution (B3) ──
// Tips ride into 2300 Tips Payable on checkout (a staff pass-through liability). A distribution pays the
// pooled tips out to staff for a period — Dr 2300 / Cr 1000 — clearing the liability. Header + per-staff
// lines; tenant_id → RLS.
export const tipDistributions = pgTable('tip_distributions', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull().references(() => tenants.id),
  distNo: text('dist_no').notNull(),               // TIP-YYYYMMDD-NNN
  periodFrom: text('period_from').notNull(),         // YYYY-MM-DD (inclusive)
  periodTo: text('period_to').notNull(),             // YYYY-MM-DD (inclusive)
  method: text('method').notNull().default('equal'), // 'equal' | 'hours' | 'weight'
  poolAmount: numeric('pool_amount', { precision: 18, scale: 4 }).notNull(),
  payAccount: text('pay_account').notNull().default('1000'), // GL credited (cash paid out)
  journalNo: text('journal_no'),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});
export const tipDistributionLines = pgTable('tip_distribution_lines', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull().references(() => tenants.id),
  distId: bigint('dist_id', { mode: 'number' }).notNull().references(() => tipDistributions.id),
  staff: text('staff').notNull(),                    // username / staff code
  basis: numeric('basis', { precision: 18, scale: 4 }).notNull().default('0'), // hours or weight used
  share: numeric('share', { precision: 9, scale: 6 }).notNull().default('0'),  // fraction of the pool
  amount: numeric('amount', { precision: 18, scale: 4 }).notNull(),
});

export type DiningTable = typeof diningTables.$inferSelect;
export type TableReservation = typeof tableReservations.$inferSelect;
export type TipDistribution = typeof tipDistributions.$inferSelect;
export type TableSession = typeof tableSessions.$inferSelect;
export type DineInOrder = typeof dineInOrders.$inferSelect;
export type DineInOrderItem = typeof dineInOrderItems.$inferSelect;
export type OrderDeliveryDetail = typeof orderDeliveryDetails.$inferSelect;
export type ChannelWebhookEvent = typeof channelWebhookEvents.$inferSelect;
