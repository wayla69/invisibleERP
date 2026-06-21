import { pgEnum } from 'drizzle-orm/pg-core';

// Postgres enums — vocabulary ตรงกับระบบเดิม (string values load-bearing).
// ใช้กับสถานะที่นิยามชัด; สถานะ/ประเภทที่หลวมกว่า (payment_method, txn_type, ...) คงเป็น text เพื่อความยืดหยุ่น.

export const roleEnum = pgEnum('role_enum', ['Admin', 'Sales', 'Customer', 'Warehouse', 'Procurement', 'Planner']);
export const orderStatusEnum = pgEnum('order_status', ['Pending', 'Processing', 'Shipped', 'Completed', 'Claimed', 'Cancelled']);
export const claimStatusEnum = pgEnum('claim_status', ['Waiting', 'Approved', 'Rejected']);
export const posStatusEnum = pgEnum('pos_status', ['Completed', 'Voided', 'Open']);
export const poStatusEnum = pgEnum('po_status', ['Draft', 'Pending', 'Approved', 'Received', 'Closed', 'Cancelled']);
export const invoiceStatusEnum = pgEnum('invoice_status', ['Unpaid', 'Partial', 'Paid', 'Cancelled']);
export const moveTypeEnum = pgEnum('move_type', ['Issue', 'Transfer', 'GR', 'Return', 'Stock In', 'Stock Out']);
export const lotStatusEnum = pgEnum('lot_status', ['Active', 'Consumed', 'Expired', 'Quarantine']);
export const stocktakeStatusEnum = pgEnum('stocktake_status', ['Draft', 'Posted']);
