import { pgTable, bigserial, bigint, text, numeric, date, timestamp } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

export const deliveryOrders = pgTable('delivery_orders', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  doNo: text('do_no').notNull().unique(), // DO-
  doDate: date('do_date'),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  address: text('address'),
  driver: text('driver'),
  vehicle: text('vehicle'),
  status: text('status').default('Pending'),
  deliveredAt: timestamp('delivered_at', { withTimezone: true }),
  podImageKey: text('pod_image_key'),
  remarks: text('remarks'),
  createdBy: text('created_by'),
});

export const doItems = pgTable('do_items', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  doId: bigint('do_id', { mode: 'number' }).references(() => deliveryOrders.id),
  orderNo: text('order_no'),
  itemId: text('item_id'),
  itemDescription: text('item_description'),
  qty: numeric('qty'),
  uom: text('uom'),
  status: text('status').default('Pending'),
});
