-- SoD remediation: add single-duty roles to the role_enum (the remediated role design).
-- ADD VALUE IF NOT EXISTS is idempotent (PG 12+). Legacy roles are retained for transition.
ALTER TYPE "role_enum" ADD VALUE IF NOT EXISTS 'Cashier';
--> statement-breakpoint
ALTER TYPE "role_enum" ADD VALUE IF NOT EXISTS 'PosSupervisor';
--> statement-breakpoint
ALTER TYPE "role_enum" ADD VALUE IF NOT EXISTS 'ArClerk';
--> statement-breakpoint
ALTER TYPE "role_enum" ADD VALUE IF NOT EXISTS 'ApClerk';
--> statement-breakpoint
ALTER TYPE "role_enum" ADD VALUE IF NOT EXISTS 'Buyer';
--> statement-breakpoint
ALTER TYPE "role_enum" ADD VALUE IF NOT EXISTS 'WarehouseOperator';
--> statement-breakpoint
ALTER TYPE "role_enum" ADD VALUE IF NOT EXISTS 'InventoryController';
--> statement-breakpoint
ALTER TYPE "role_enum" ADD VALUE IF NOT EXISTS 'StockCounter';
--> statement-breakpoint
ALTER TYPE "role_enum" ADD VALUE IF NOT EXISTS 'GlAccountant';
--> statement-breakpoint
ALTER TYPE "role_enum" ADD VALUE IF NOT EXISTS 'FinancialController';
--> statement-breakpoint
ALTER TYPE "role_enum" ADD VALUE IF NOT EXISTS 'MasterDataAdmin';
--> statement-breakpoint
ALTER TYPE "role_enum" ADD VALUE IF NOT EXISTS 'PricingManager';
--> statement-breakpoint
ALTER TYPE "role_enum" ADD VALUE IF NOT EXISTS 'CreditManager';
--> statement-breakpoint
ALTER TYPE "role_enum" ADD VALUE IF NOT EXISTS 'ReturnsClerk';
--> statement-breakpoint
ALTER TYPE "role_enum" ADD VALUE IF NOT EXISTS 'AccessAdmin';
--> statement-breakpoint
ALTER TYPE "role_enum" ADD VALUE IF NOT EXISTS 'ExecutiveViewer';
