// Restaurant / F&B POS: kitchen stations + KDS, floor-plan tables + zones, table sessions
// (public QR diner sessions), dine-in orders + items (kitchen tickets). Every table carries
// tenant_id so the 0002 RLS loop (re-run in 0006) scopes them automatically.
import { pgTable, bigserial, bigint, text, numeric, integer, timestamp, boolean, jsonb } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';
import { dineInOrderStatusEnum, kdsItemStatusEnum, tableStatusEnum, tableSessionStatusEnum, orderChannelEnum, fulfillmentTypeEnum, fulfillmentStatusEnum } from './enums';

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
});

// ── ออเดอร์ทานที่ร้าน (kitchen ticket header) ──
export const dineInOrders = pgTable('dine_in_orders', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  orderNo: text('order_no').notNull().unique(),         // DIN-YYYYMMDD-NNN
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  tableId: bigint('table_id', { mode: 'number' }).references(() => diningTables.id),
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
  kdsStatus: kdsItemStatusEnum('kds_status').notNull().default('new'),
  estPrepMinutes: integer('est_prep_minutes'),
  firedAt: timestamp('fired_at', { withTimezone: true }),
  startedAt: timestamp('started_at', { withTimezone: true }),
  readyAt: timestamp('ready_at', { withTimezone: true }),
  servedAt: timestamp('served_at', { withTimezone: true }),
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

export type DiningTable = typeof diningTables.$inferSelect;
export type TableSession = typeof tableSessions.$inferSelect;
export type DineInOrder = typeof dineInOrders.$inferSelect;
export type DineInOrderItem = typeof dineInOrderItems.$inferSelect;
export type OrderDeliveryDetail = typeof orderDeliveryDetails.$inferSelect;
export type ChannelWebhookEvent = typeof channelWebhookEvents.$inferSelect;
