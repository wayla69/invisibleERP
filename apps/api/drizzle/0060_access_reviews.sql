-- ITGC-AC-08: User Access Review attestation log (periodic recertification sign-off).
CREATE TABLE IF NOT EXISTS "access_reviews" (
  "id" bigserial PRIMARY KEY NOT NULL,
  "period" text NOT NULL,
  "reviewed_by" text NOT NULL,
  "reviewed_at" timestamp with time zone DEFAULT now(),
  "user_count" integer,
  "conflict_user_count" integer,
  "notes" text,
  "tenant_id" bigint REFERENCES "tenants"("id")
);
