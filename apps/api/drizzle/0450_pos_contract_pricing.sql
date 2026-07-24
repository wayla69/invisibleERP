-- docs/52 Phase 4d — B2B contract pricing: a price book can be scoped to a specific customer.
-- NULL = any customer (the pre-4d behaviour → byte-identical). A customer-scoped book is the most
-- specific match and wins over tier/branch books at resolution. price_books is already tenant-scoped
-- (RLS + app_user grant from 0447), so the new column needs no policy/grant of its own.
ALTER TABLE "price_books" ADD COLUMN IF NOT EXISTS "customer_code" text;
