import { pgEnum } from 'drizzle-orm/pg-core';

// Postgres enums — vocabulary ตรงกับระบบเดิม (string values load-bearing).
// ใช้กับสถานะที่นิยามชัด; สถานะ/ประเภทที่หลวมกว่า (payment_method, txn_type, ...) คงเป็น text เพื่อความยืดหยุ่น.

export const roleEnum = pgEnum('role_enum', [
  'Admin', 'Sales', 'Customer', 'Warehouse', 'Procurement', 'Planner',
  // SoD-clean single-duty roles (added by migration 0059)
  'Cashier', 'PosSupervisor', 'ArClerk', 'ApClerk', 'Buyer', 'WarehouseOperator',
  'InventoryController', 'StockCounter', 'GlAccountant', 'FinancialController',
  'MasterDataAdmin', 'PricingManager', 'CreditManager', 'ReturnsClerk', 'AccessAdmin', 'ExecutiveViewer',
  // Treasury (Track C Wave 1) — added by migration 0352
  'TreasuryAnalyst', 'TreasuryManager',
]);
export const orderStatusEnum = pgEnum('order_status', ['Pending', 'Processing', 'Shipped', 'Completed', 'Claimed', 'Cancelled']);
export const claimStatusEnum = pgEnum('claim_status', ['Waiting', 'Approved', 'Rejected']);
export const posStatusEnum = pgEnum('pos_status', ['Completed', 'Voided', 'Open']);
export const poStatusEnum = pgEnum('po_status', ['Draft', 'Pending', 'Approved', 'Received', 'Closed', 'Cancelled']);
export const invoiceStatusEnum = pgEnum('invoice_status', ['Unpaid', 'Partial', 'Paid', 'Cancelled']);
export const moveTypeEnum = pgEnum('move_type', ['Issue', 'Transfer', 'GR', 'Return', 'Stock In', 'Stock Out']);
export const lotStatusEnum = pgEnum('lot_status', ['Active', 'Consumed', 'Expired', 'Quarantine']);
export const stocktakeStatusEnum = pgEnum('stocktake_status', ['Draft', 'Posted']);

// ── Restaurant / F&B POS ──
export const dineInOrderStatusEnum = pgEnum('dine_in_order_status', ['open', 'sent_to_kitchen', 'partially_ready', 'served', 'bill_requested', 'partially_paid', 'paid', 'closed', 'cancelled']);
export const kdsItemStatusEnum = pgEnum('kds_item_status', ['new', 'queued', 'preparing', 'ready', 'served', 'voided']);
export const tableStatusEnum = pgEnum('table_status', ['available', 'reserved', 'occupied', 'bill_requested', 'paying', 'cleaning', 'out_of_service']);
// Reservations + walk-in waitlist share one lifecycle: a future booking starts 'booked', a walk-in queue
// entry starts 'waiting'; both move to 'ready' (guest notified), then 'seated' — or 'cancelled'/'no_show'.
export const reservationStatusEnum = pgEnum('reservation_status', ['booked', 'waiting', 'ready', 'seated', 'cancelled', 'no_show']);
// ── Online ordering / delivery / kiosk (POS Tier 2 #10) ──
export const orderChannelEnum = pgEnum('order_channel', ['dine_in', 'web', 'kiosk', 'grab', 'lineman', 'in_store']);
export const fulfillmentTypeEnum = pgEnum('fulfillment_type', ['dine_in', 'takeaway', 'delivery', 'pickup']);
export const fulfillmentStatusEnum = pgEnum('fulfillment_status', ['received', 'accepted', 'preparing', 'ready', 'out_for_delivery', 'completed', 'rejected']);
export const tableSessionStatusEnum = pgEnum('table_session_status', ['open', 'bill_requested', 'paying', 'closed', 'abandoned']);
// ── Buffet self-ordering (Phase 2): a session runs in one mode ──
export const orderModeEnum = pgEnum('order_mode', ['a_la_carte', 'buffet']);
