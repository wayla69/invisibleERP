-- ITGC-AC-13 — production database least-privilege roles.
-- Run ONCE by a DBA/superuser against the managed Postgres (Railway etc.) when provisioning prod.
-- This is intentionally NOT a Drizzle migration: it manages LOGIN roles/passwords and ownership,
-- which are environment-specific, must be run with elevated privileges, and must never execute inside
-- the application's migration user or the PGlite test harnesses (which run every drizzle/*.sql file).
--
-- Model:
--   * The app connects as a dedicated LOGIN role `ierp_app` that is NOT the database owner and is NOT
--     a superuser. RLS (migration 0002_rls.sql) is FORCED on every tenant table, so even a forgotten
--     WHERE cannot cross tenants — and because `ierp_app` is non-owner, FORCE RLS is not bypassed.
--   * `0002_rls.sql` already creates the NOLOGIN privilege role `app_user` and grants it table/sequence
--     DML. Here we create the LOGIN principal and put it in that group, so grants stay in one place.
--
-- After running: set DATABASE_URL to use ierp_app, e.g.
--   postgresql://ierp_app:<password>@<host>:5432/invisible_erp_v2
--
-- Replace the password below with a secret pulled from your vault (see docs/ops/secrets.md).

\set app_password `echo "${IERP_APP_PASSWORD:?set IERP_APP_PASSWORD before running}"`

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user NOLOGIN;  -- defensive: normally created by 0002_rls.sql
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'ierp_app') THEN
    CREATE ROLE ierp_app LOGIN;
  END IF;
END $$;

ALTER ROLE ierp_app WITH PASSWORD :'app_password';
GRANT app_user TO ierp_app;            -- inherit the least-privilege DML grants
ALTER ROLE ierp_app SET role = app_user; -- always act as the RLS-bound role

-- Lock down the public schema: no implicit privileges for PUBLIC; app gets exactly what app_user has.
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO app_user;

-- Make sure RLS is FORCED for everyone including table owners (idempotent re-assert of 0002 intent).
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_schema='public' AND table_name=r.tablename AND column_name='tenant_id') THEN
      EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', r.tablename);
    END IF;
  END LOOP;
END $$;
