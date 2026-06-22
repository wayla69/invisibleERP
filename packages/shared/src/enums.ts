// Domain enums ported verbatim from the legacy system (string values are load-bearing).
// In V2 these become Postgres enums; keep the exact string vocabulary for parity.

export const ROLES = [
  // Legacy broad roles (retained for transition; flagged by SoD until users migrate).
  'Admin', 'Sales', 'Customer', 'Warehouse', 'Procurement', 'Planner',
  // SoD-clean single-duty roles (the remediated design — see DEFAULT_ROLE_PERMISSIONS).
  'Cashier', 'PosSupervisor', 'ArClerk', 'ApClerk', 'Buyer', 'WarehouseOperator',
  'InventoryController', 'StockCounter', 'GlAccountant', 'FinancialController',
  'MasterDataAdmin', 'PricingManager', 'CreditManager', 'ReturnsClerk', 'AccessAdmin', 'ExecutiveViewer',
] as const;
export type Role = (typeof ROLES)[number];

// Sales order lifecycle (6 states) + derived "Partial Claim" at the UI layer
export const ORDER_STATUS = ['Pending', 'Processing', 'Shipped', 'Completed', 'Claimed', 'Cancelled'] as const;
export type OrderStatus = (typeof ORDER_STATUS)[number];

export const CLAIM_STATUS = ['Waiting', 'Approved', 'Rejected'] as const;
export type ClaimStatus = (typeof CLAIM_STATUS)[number];

// Customer-POS retail sale status
export const POS_STATUS = ['Completed', 'Voided', 'Open'] as const;
export type PosStatus = (typeof POS_STATUS)[number];

export const PO_STATUS = ['Draft', 'Pending', 'Approved', 'Received', 'Closed', 'Cancelled'] as const;
export type PoStatus = (typeof PO_STATUS)[number];

export const INVOICE_STATUS = ['Unpaid', 'Partial', 'Paid', 'Cancelled'] as const;
export type InvoiceStatus = (typeof INVOICE_STATUS)[number];

export const MOVE_TYPE = ['Issue', 'Transfer', 'GR', 'Return', 'Stock In', 'Stock Out'] as const;
export type MoveType = (typeof MOVE_TYPE)[number];

export const PAYMENT_METHODS = ['Cash', 'QR Code', 'Transfer', 'Card', 'Cheque', 'Credit Card'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

// Stock-log type vocabulary used by customer inventory ledger
export const STOCK_LOG_TYPE = ['Sale', 'Production', 'Production-FG', 'Issue', 'Adjustment', 'EOD-Count'] as const;
export type StockLogType = (typeof STOCK_LOG_TYPE)[number];

// Business constants (parity-critical magic numbers — see legacy_inventory/)
export const CONST = {
  VAT_RATE: 0.07, // 7% Thai VAT (customer POS, tax invoice, Express TXT)
  ANALYTICS_Z_THRESHOLD: 2.5,
  ANALYTICS_Z_CRITICAL: 3.5,
  ANALYTICS_SAFETY_FACTOR: 1.5,
  LEAD_TIME_FALLBACK_DAYS: 7,
  VARIANCE_THRESHOLD_PCT: 20,
  VARIANCE_CRITICAL_PCT: 50,
  FORECAST_LOOKBACK_DAYS: 60,
  REPLENISHMENT_CANDIDATE_LIMIT: 200,
  AGENT_MAX_LOOP_TURNS: 15,
  AGENT_MAX_HISTORY: 40,
} as const;
