# Doc 18 — Finance & GL "Real ERP" Master Blueprint

**Owner:** CTO/Lead Architect · **Status:** Approved for implementation · **Date:** 2026-06-26
**Scope:** 11 workstreams / PRs (WS1.1 → WS3.4) that turn the hardcoded GL into a configurable,
multi-dimensional, auditable ERP ledger. This is the source-of-truth spec passed to the implementer.

---

## 1. System Architecture & Tech Stack Rules

### Stack (pinned versions — do NOT upgrade without a separate workstream)
| Layer | Technology | Version / constraint |
|-------|-----------|----------------------|
| API runtime | NestJS + Fastify | existing; add no new NestJS modules without approval |
| ORM | drizzle-orm | **^0.36.4 — pinned, do NOT bump** (0.45 has insert regression) |
| DB | PostgreSQL + RLS | multi-tenant via `tenant_id`; every new table with `tenant_id` gets the RLS loop in its migration |
| Package manager | pnpm | 11.8.0 from `packageManager` field — do NOT also pin in `pnpm/action-setup` |
| Frontend | Next.js 14 App Router + SWR | existing; new pages use `ModulePage` scaffold from `apps/web/src/components/` |
| Shared types | `@ierp/shared` | add new permissions and enums here, always `pnpm --filter @ierp/shared build` first |
| Thai timezone | Asia/Bangkok (UTC+7) | all business dates via `ymd()` / `bizYmdDash` — never raw `new Date()` |
| Currency | THB default | numeric(18,4) for amounts; numeric(18,8) for FX rates |

### Strict folder structure (API — follow exactly)
```
apps/api/src/
  modules/
    ledger/
      ledger.service.ts         ← existing GL engine (extend only)
      ledger.controller.ts      ← existing (add routes here)
      ledger.module.ts          ← export new services
      coa.service.ts            ← NEW WS1.1
      coa.controller.ts         ← NEW WS1.1
      posting.service.ts        ← NEW WS1.2
      posting-rules.controller.ts ← NEW WS1.2
      close.service.ts          ← NEW WS2.1
      close.controller.ts       ← NEW WS2.1
      cost-centers.service.ts   ← existing
      cost-centers.controller.ts ← existing
    finance/
      finance.service.ts        ← existing (add AR controls WS2.3)
      collections.service.ts    ← existing (wire dunning gate WS2.3)
    tax/
      tax-filing.service.ts     ← NEW WS3.1
      tax-filing.controller.ts  ← NEW WS3.1
  database/schema/
    ledger.ts                   ← extend accounts, journalLines, add new tables
    finance.ts                  ← extend with allowance, credit tables
    tax-docs.ts                 ← extend with filing tables
    posting-rules.ts            ← NEW WS1.2
    close.ts                    ← NEW WS2.1
    deferred-tax.ts             ← NEW WS3.2
    segments.ts                 ← NEW WS3.3
    revrec.ts                   ← NEW WS3.4
  drizzle/
    NNNN_*.sql                  ← one file per WS; journal entry required
    meta/_journal.json          ← CRLF line endings; append only; idx sequential
```

### Naming conventions (enforced)
- Tables: `snake_case`, plural nouns. Columns: `snake_case`.
- Drizzle schema objects: `camelCase` (e.g. `journalLines`, `postingRules`).
- Service methods: `camelCase` verbs (e.g. `createAccount`, `postEvent`).
- DTO interfaces: `PascalCaseDto` in the service file.
- Error codes: `SCREAMING_SNAKE` (e.g. `CONTROL_ACCOUNT`, `PERIOD_LOCKED`).
- Thai message field: always `messageTh` alongside `message`.
- Migration file: `NNNN_descriptive_name.sql` where NNNN is the NEXT FREE 4-digit number.
- All new GL accounts added to the `COA` array AND seeded in the migration.

### Code rules (non-negotiable)
1. **No raw `sql` template for user-input date/number params** — use typed builders (`gte`, `lte`, `eq`).
2. **No raw `new Date()` / `Date.now()`** — use `ymd()` from `database/queries`.
3. **No direct debit/credit strings in new code** — new callers use `PostingService.post()` (WS1.2).
4. **No `allowClosedPeriod: true`** in new code (removed from new callers; the flag exists only for the
   year-end close path in `ledger.service.ts`).
5. **Every `postEntry` call must pass `createdBy`** (audit trail).
6. **Balance-check in `postEntry` is the source of truth** — do NOT pre-validate elsewhere.
7. **Maker-checker via `pendingApproval: true`** for all privileged financial actions.
8. **RLS loop** on every new table that carries `tenant_id` (copy pattern from 0043).

---

## 2. Data Flow & State Management

### API data flow (read path)
```
PostgreSQL (RLS-scoped by tenant_id)
  → Drizzle query in service (typed builders, never raw sql for user input)
  → NestJS service method (business logic, throws HttpException on error)
  → NestJS controller (Zod validation, @Permissions guard, @JwtUser decorator)
  → REST JSON response { data, meta? }
  → Next.js: useSWR hook or server component fetch
  → UI component (ModulePage scaffold, DataTable, FormField primitives)
```

### API data flow (write path / GL posting)
```
HTTP POST → Controller (Zod DTO, @Permissions guard)
  → PostingService.post(eventType, PostingContext)    ← WS1.2 (new callers)
    → resolve posting_rules for event + tenant
    → stamp branchId/projectId/deptId from context    ← WS1.3
    → validate account isPostable + not control        ← WS1.1/WS1.4
    → call LedgerService.postEntry(dto, outerTx)
      → period guard (hard after WS2.1)
      → debit == credit guard
      → INSERT journal_entries ON CONFLICT DO NOTHING (idempotency)
      → INSERT journal_lines (with branch_id, project_id, dept_id)  ← WS1.3
      → return { entryId, entryNo }
```

### State: no `session_state` (this is NestJS, not Streamlit)
API state management:
- **Tenant context**: `currentTenantStore()` ALS (AsyncLocalStorage) — set by `TenantInterceptor`.
- **No singleton state** in services — all state lives in PostgreSQL.
- **Idempotency**: `(tenant_id, source, source_ref, ledger_code)` unique index on `journal_entries`.
- **Maker-checker state**: `status` field on `journal_entries` (`Draft` | `Posted`) and close_runs.
- **Period state**: `fiscal_periods.status` (`Open` | `Closed` | `Locked` — `Locked` is new, WS2.1).

---

## 3. Database Schema — exact definitions for all 11 migrations

### Migration 0155 — CoA master data (WS1.1)
**Table: `account_groups`** (new)
```sql
CREATE TABLE account_groups (
  id          BIGSERIAL PRIMARY KEY,
  tenant_id   BIGINT REFERENCES tenants(id),  -- NULL = global template
  code        TEXT NOT NULL,
  name_th     TEXT NOT NULL,
  name_en     TEXT NOT NULL,
  type        account_type NOT NULL,
  parent_group_id BIGINT REFERENCES account_groups(id),
  sort_order  INT DEFAULT 0,
  active      BOOLEAN DEFAULT TRUE,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX uq_account_groups ON account_groups (COALESCE(tenant_id,0), code);
```
**Alter: `accounts`** (add columns)
```sql
ALTER TABLE accounts
  ADD COLUMN name_th          TEXT,
  ADD COLUMN account_group_id BIGINT REFERENCES account_groups(id),
  ADD COLUMN is_control       BOOLEAN DEFAULT FALSE,
  ADD COLUMN control_subledger TEXT,   -- 'AR'|'AP'|'INV'|'FA' or NULL
  ADD COLUMN normal_balance   TEXT DEFAULT 'D', -- 'D'=debit | 'C'=credit
  ADD COLUMN is_postable      BOOLEAN DEFAULT TRUE,
  ADD COLUMN require_dimension JSONB,  -- e.g. {"branch":true}
  ADD COLUMN effective_from   DATE,
  ADD COLUMN effective_to     DATE;
-- Seed control flags on existing accounts (run immediately after ALTER):
UPDATE accounts SET is_control=TRUE, control_subledger='AR'  WHERE code='1100';
UPDATE accounts SET is_control=TRUE, control_subledger='AP'  WHERE code='2000';
UPDATE accounts SET is_control=TRUE, control_subledger='INV' WHERE code='1200';
UPDATE accounts SET is_control=TRUE, control_subledger='FA'  WHERE code='1500';
UPDATE accounts SET normal_balance='C' WHERE type IN ('Liability','Equity','Revenue');
```
**No RLS on `accounts`** (global table, no tenant_id).
**RLS on `account_groups`** — tenant_id nullable, policy: `tenant_id IS NULL OR tenant_id = current_setting('app.tenant_id')::BIGINT`.

### Migration 0156 — Posting rules (WS1.2)
```sql
CREATE TABLE posting_event_types (
  key   TEXT PRIMARY KEY,
  name  TEXT NOT NULL,
  description TEXT
);
CREATE TABLE posting_rules (
  id          BIGSERIAL PRIMARY KEY,
  tenant_id   BIGINT REFERENCES tenants(id),  -- NULL = global default
  event_type  TEXT NOT NULL REFERENCES posting_event_types(key),
  leg_order   SMALLINT NOT NULL,              -- 1,2,3... ordering of lines
  role        TEXT NOT NULL,                  -- semantic slot e.g. 'inventory','ap_control','cogs'
  side        TEXT NOT NULL,                  -- 'DR' or 'CR'
  account_code TEXT NOT NULL,
  dimension_source TEXT,                      -- 'branch_id'|'project_id'|null
  condition   JSONB,                          -- optional filter e.g. {"category":"exempt"}
  active      BOOLEAN DEFAULT TRUE,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX uq_posting_rules ON posting_rules
  (COALESCE(tenant_id,0), event_type, leg_order);
```
RLS on `posting_rules` (tenant_id nullable — same policy as account_groups).
Seed event types: `SALE.FOOD`, `SALE.VAT`, `GR.INVENTORY`, `GR.AP`, `PAYROLL.GROSS`,
`PAYROLL.SSO`, `PAYROLL.WHT`, `PAYROLL.PF`, `DEPRECIATION.FA`, `DEPRECIATION.ROU`,
`LEASE.INTEREST`, `ADVANCE.ISSUE`, `ADVANCE.SETTLE`, `BADDEBT.WRITEOFF`, `FX.UNREALIZED`,
`FX.REALIZED`, `RETURN.STOCK`, `RETURN.AR` (and ~15 more covering all 28 existing callers).

### Migration 0157 — GL dimensions (WS1.3)
```sql
ALTER TABLE journal_lines
  ADD COLUMN branch_id     BIGINT,  -- FK branches(id) — set from PostingContext
  ADD COLUMN project_id    BIGINT,  -- FK projects(id)
  ADD COLUMN department_id BIGINT;  -- FK departments(id) (add table if absent)
CREATE INDEX idx_jl_branch ON journal_lines(branch_id);
CREATE INDEX idx_jl_project ON journal_lines(project_id);

CREATE TABLE departments (
  id        BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT REFERENCES tenants(id),
  code      TEXT NOT NULL,
  name      TEXT NOT NULL,
  active    BOOLEAN DEFAULT TRUE
);
CREATE UNIQUE INDEX uq_dept ON departments(tenant_id, code);
```
RLS on `departments` (tenant_id). No RLS on journal_lines (already scoped via join to journal_entries).

### Migration 0158 — Sub-ledger tie-out (WS1.4)
```sql
CREATE TABLE subledger_tieout_runs (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       BIGINT REFERENCES tenants(id),
  period          TEXT NOT NULL,  -- 'YYYY-MM'
  subledger       TEXT NOT NULL,  -- 'AR'|'AP'|'INV'|'FA'
  gl_balance      NUMERIC(18,4),
  subledger_balance NUMERIC(18,4),
  variance        NUMERIC(18,4),
  status          TEXT DEFAULT 'pending', -- 'pending'|'matched'|'variance'|'certified'
  certified_by    TEXT,
  certified_at    TIMESTAMPTZ,
  notes           TEXT,
  run_at          TIMESTAMPTZ DEFAULT NOW(),
  tenant_id_rls   BIGINT GENERATED ALWAYS AS (tenant_id) STORED  -- RLS target alias
);
CREATE UNIQUE INDEX uq_tieout ON subledger_tieout_runs(tenant_id, period, subledger);
```
RLS on `subledger_tieout_runs`.

### Migration 0159 — Period close checklist (WS2.1)
```sql
CREATE TABLE close_runs (
  id          BIGSERIAL PRIMARY KEY,
  tenant_id   BIGINT REFERENCES tenants(id),
  period      TEXT NOT NULL,
  status      TEXT DEFAULT 'open',  -- 'open'|'in_progress'|'locked'|'reopened'
  started_by  TEXT,
  locked_by   TEXT,
  locked_at   TIMESTAMPTZ,
  reopened_by TEXT,
  reopened_at TIMESTAMPTZ,
  notes       TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX uq_close_runs ON close_runs(tenant_id, period);

CREATE TABLE close_run_steps (
  id          BIGSERIAL PRIMARY KEY,
  run_id      BIGINT REFERENCES close_runs(id),
  step_key    TEXT NOT NULL,        -- 'bank_recon'|'fx_reval'|'accruals'|'subledger_tieout'|
                                    -- 'depreciation'|'prepaid_run'|'recurring_run'|'gl_lock'
  step_order  SMALLINT NOT NULL,
  status      TEXT DEFAULT 'pending', -- 'pending'|'complete'|'skipped'
  completed_by TEXT,
  completed_at TIMESTAMPTZ,
  evidence_ref TEXT
);
```
Add `'Locked'` to `period_status` enum:
```sql
ALTER TYPE period_status ADD VALUE IF NOT EXISTS 'Locked';
```
RLS on `close_runs`, `close_run_steps`.

### Migration 0160 — GL immutability (WS2.2)
```sql
ALTER TABLE journal_entries
  ADD COLUMN posted_at    TIMESTAMPTZ,
  ADD COLUMN reversal_of  BIGINT REFERENCES journal_entries(id),
  ADD COLUMN is_reversed  BOOLEAN DEFAULT FALSE;

-- Immutability trigger: block UPDATE/DELETE on Posted entries
CREATE OR REPLACE FUNCTION trg_je_immutable() RETURNS TRIGGER AS $$
BEGIN
  IF OLD.status = 'Posted' THEN
    RAISE EXCEPTION 'IMMUTABLE_ENTRY: posted journal entries cannot be modified (entry %)', OLD.entry_no;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER je_immutable_upd BEFORE UPDATE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION trg_je_immutable();
CREATE TRIGGER je_immutable_del BEFORE DELETE ON journal_entries
  FOR EACH ROW WHEN (OLD.status = 'Posted') EXECUTE FUNCTION trg_je_immutable();

CREATE TABLE gl_audit_log (
  id          BIGSERIAL PRIMARY KEY,
  entry_id    BIGINT REFERENCES journal_entries(id),
  action      TEXT NOT NULL,   -- 'POST'|'REVERSE'|'DRAFT'|'APPROVE'|'REJECT'
  actor       TEXT NOT NULL,
  source_ip   TEXT,
  payload     JSONB,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
```
No RLS on `gl_audit_log` (global audit — Admin sees all tenants; controller sees own via join).

### Migration 0161 — AR/AP controls (WS2.3)
```sql
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS credit_limit   NUMERIC(14,2),
  ADD COLUMN IF NOT EXISTS credit_hold    BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS payment_terms  TEXT DEFAULT 'NET30';

CREATE TABLE ar_allowance (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       BIGINT REFERENCES tenants(id),
  period          TEXT NOT NULL,
  method          TEXT DEFAULT 'aging', -- 'aging'|'percent'
  provision_amount NUMERIC(14,2),
  status          TEXT DEFAULT 'draft', -- 'draft'|'posted'
  posted_entry_no TEXT,
  posted_by       TEXT,
  posted_at       TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE tenant_accounts   -- reuse for match policy storage
  -- (ap_match_policy stored as system_config key instead — see implementation note)
  ;

CREATE TABLE ap_match_policy (
  id            BIGSERIAL PRIMARY KEY,
  tenant_id     BIGINT REFERENCES tenants(id) UNIQUE,
  require_3way  BOOLEAN DEFAULT TRUE,
  qty_pct       NUMERIC(5,2) DEFAULT 3.0,  -- % tolerance
  price_pct     NUMERIC(5,2) DEFAULT 2.0,
  amount_abs    NUMERIC(14,2) DEFAULT 100  -- THB absolute tolerance
);
```
RLS on `ar_allowance`, `ap_match_policy`.

### Migration 0162 — Thai tax filing (WS3.1)
```sql
CREATE TABLE vat_returns (
  id           BIGSERIAL PRIMARY KEY,
  tenant_id    BIGINT REFERENCES tenants(id),
  period       TEXT NOT NULL,   -- 'YYYY-MM'
  form         TEXT DEFAULT 'PP30',
  output_vat   NUMERIC(14,2) DEFAULT 0,
  input_vat    NUMERIC(14,2) DEFAULT 0,
  net_payable  NUMERIC(14,2) DEFAULT 0,
  line_count   INT DEFAULT 0,
  status       TEXT DEFAULT 'draft', -- 'draft'|'reviewed'|'filed'|'amended'
  filed_at     TIMESTAMPTZ,
  filing_ref   TEXT,
  created_by   TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX uq_vat_returns ON vat_returns(tenant_id, period, form);

CREATE TABLE wht_filings (
  id           BIGSERIAL PRIMARY KEY,
  tenant_id    BIGINT REFERENCES tenants(id),
  form         TEXT NOT NULL,  -- 'PND1'|'PND3'|'PND53'
  period       TEXT NOT NULL,
  total_income NUMERIC(14,2) DEFAULT 0,
  total_wht    NUMERIC(14,2) DEFAULT 0,
  line_count   INT DEFAULT 0,
  remit_due    DATE,
  status       TEXT DEFAULT 'draft',
  filed_at     TIMESTAMPTZ,
  created_by   TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX uq_wht_filings ON wht_filings(tenant_id, period, form);

CREATE TABLE tax_calendar (
  id          BIGSERIAL PRIMARY KEY,
  tenant_id   BIGINT REFERENCES tenants(id),
  tax_type    TEXT NOT NULL,   -- 'VAT_PP30'|'WHT_PND1'|'WHT_PND3'|'WHT_PND53'|'CIT_PND50'
  period      TEXT NOT NULL,
  due_date    DATE NOT NULL,
  status      TEXT DEFAULT 'pending',  -- 'pending'|'filed'|'overdue'
  filing_id   BIGINT,                  -- fk to vat_returns or wht_filings
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
```
RLS on all three tables.

### Migration 0163 — Deferred tax + FX reval (WS3.2)
```sql
-- New GL accounts (seed in COA):
-- 1700 Deferred Tax Asset, 2700 Deferred Tax Liability, 5950 Deferred Tax Expense

CREATE TABLE deferred_tax_runs (
  id           BIGSERIAL PRIMARY KEY,
  tenant_id    BIGINT REFERENCES tenants(id),
  period       TEXT NOT NULL,
  temp_diff    NUMERIC(14,2),    -- taxable temp differences (TFRS-TAX net)
  tax_rate     NUMERIC(5,4) DEFAULT 0.20,
  dta_dtl      NUMERIC(14,2),   -- positive=DTA, negative=DTL
  movement     NUMERIC(14,2),   -- change from prior period
  entry_no     TEXT,
  status       TEXT DEFAULT 'draft',
  created_by   TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX uq_dt_runs ON deferred_tax_runs(tenant_id, period);

CREATE TABLE fx_reval_runs (
  id           BIGSERIAL PRIMARY KEY,
  tenant_id    BIGINT REFERENCES tenants(id),
  period       TEXT NOT NULL,
  reval_date   DATE NOT NULL,
  items_revalued INT DEFAULT 0,
  total_unrealized NUMERIC(14,2),
  entry_no     TEXT,
  status       TEXT DEFAULT 'draft',
  created_by   TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX uq_fx_reval ON fx_reval_runs(tenant_id, period);
```
RLS on both tables.

### Migration 0164 — Consolidation eliminations + segments (WS3.3)
```sql
CREATE TABLE consol_elimination_rules (
  id            BIGSERIAL PRIMARY KEY,
  group_id      BIGINT,                -- FK consolidation_groups(id) — existing table
  entity_a      BIGINT REFERENCES tenants(id),
  entity_b      BIGINT REFERENCES tenants(id),
  dr_account    TEXT NOT NULL,         -- the account to debit in elimination
  cr_account    TEXT NOT NULL,
  description   TEXT,
  active        BOOLEAN DEFAULT TRUE
);

CREATE TABLE segment_definitions (
  id           BIGSERIAL PRIMARY KEY,
  tenant_id    BIGINT REFERENCES tenants(id),
  code         TEXT NOT NULL,
  name         TEXT NOT NULL,
  dimension    TEXT NOT NULL,  -- 'branch'|'department'|'project'
  dimension_id BIGINT NOT NULL, -- FK to the corresponding master row
  active       BOOLEAN DEFAULT TRUE
);
CREATE UNIQUE INDEX uq_segments ON segment_definitions(tenant_id, code);
```
RLS on `segment_definitions`. No RLS on `consol_elimination_rules` (group-level, admin only).

### Migration 0165 — Revenue recognition TFRS 15 (WS3.4)
```sql
CREATE TABLE rev_contracts (
  id           BIGSERIAL PRIMARY KEY,
  contract_no  TEXT NOT NULL UNIQUE,
  tenant_id    BIGINT REFERENCES tenants(id),
  customer_ref TEXT,
  description  TEXT,
  total_amount NUMERIC(14,2),
  currency     TEXT DEFAULT 'THB',
  start_date   DATE,
  end_date     DATE,
  status       TEXT DEFAULT 'active', -- 'active'|'complete'|'cancelled'
  created_by   TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE performance_obligations (
  id           BIGSERIAL PRIMARY KEY,
  contract_id  BIGINT REFERENCES rev_contracts(id),
  description  TEXT NOT NULL,
  ssp          NUMERIC(14,2) NOT NULL,  -- standalone selling price
  allocation_pct NUMERIC(7,4),          -- computed: ssp / Σssp
  method       TEXT NOT NULL,  -- 'point_in_time'|'over_time'|'milestone'
  milestone_condition TEXT,
  status       TEXT DEFAULT 'active'
);

CREATE TABLE revrec_schedules (
  id            BIGSERIAL PRIMARY KEY,
  obligation_id BIGINT REFERENCES performance_obligations(id),
  tenant_id     BIGINT REFERENCES tenants(id),
  period        TEXT NOT NULL,
  amount        NUMERIC(14,2),
  status        TEXT DEFAULT 'pending', -- 'pending'|'recognized'|'deferred'
  entry_no      TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE refund_liability (
  id            BIGSERIAL PRIMARY KEY,
  contract_id   BIGINT REFERENCES rev_contracts(id),
  tenant_id     BIGINT REFERENCES tenants(id),
  expected_returns NUMERIC(14,2),
  provision_pct NUMERIC(5,4),
  entry_no      TEXT,
  period        TEXT,
  status        TEXT DEFAULT 'draft'
);
```
RLS on `rev_contracts`, `performance_obligations`, `revrec_schedules`, `refund_liability`.

---

## 4. Edge Cases & Error Handling

### GL posting guards (all enforced in `postEntry` / `PostingService`)
| Scenario | Error code | HTTP | Behaviour |
|----------|-----------|------|-----------|
| Posting to inactive account | `ACCOUNT_INACTIVE` | 422 | Throw before insert |
| Posting to non-postable (header) account | `ACCOUNT_NOT_POSTABLE` | 422 | Throw |
| Direct post to control account (bypass) | `CONTROL_ACCOUNT` | 422 | Throw unless `viaSubledger:true` |
| Posting to closed/locked period | `PERIOD_CLOSED` | 422 | Throw (no `allowClosedPeriod` escape in new code) |
| Unbalanced entry (Σdebit ≠ Σcredit) | `UNBALANCED` | 422 | Existing guard, keep |
| Duplicate source_ref (idempotency) | — | 200 | Silently no-op (ON CONFLICT DO NOTHING), return existing entryNo |
| Account code not found in `accounts` | `ACCOUNT_NOT_FOUND` | 422 | Throw with the code |
| `required_dimension` not met on line | `DIMENSION_REQUIRED` | 422 | Throw naming which dim |

### Period close guards (WS2.1)
| Scenario | Behaviour |
|----------|-----------|
| Close step attempted out of sequence | `STEP_PREREQUISITE` 422 — block |
| Close run not started before locking | `CLOSE_NOT_STARTED` 422 |
| Same user who started the run tries to lock | `CLOSE_SOD_VIOLATION` 403 |
| Late post to `Locked` period | `PERIOD_LOCKED` 422 — harder than `PERIOD_CLOSED`, no escape |
| Re-open requires a different approver | `REOPEN_SOD_VIOLATION` 403 |

### Sub-ledger tie-out (WS1.4)
| Scenario | Behaviour |
|----------|-----------|
| Tie-out variance ≠ 0 | Status `'variance'`; do NOT block postings; generate alert |
| Certifying own tie-out | `TIEOUT_SOD_VIOLATION` 403 |
| Tie-out already certified for period | `ALREADY_CERTIFIED` 409 |

### CoA changes (WS1.1)
| Scenario | Behaviour |
|----------|-----------|
| Edit account code that has posted entries | `CODE_HAS_POSTINGS` 422 |
| Deactivate account with non-zero balance | `ACCOUNT_HAS_BALANCE` 422 |
| Create account with duplicate code | `DUPLICATE_ACCOUNT` 409 |
| Set non-postable on control account | `CONTROL_MUST_BE_POSTABLE` 422 |

### Posting rules (WS1.2)
| Scenario | Behaviour |
|----------|-----------|
| Rule set doesn't balance (Σ DR roles ≠ Σ CR roles) | `RULE_UNBALANCED` 422 at save time |
| No rule found for event + tenant | Fall through to global default; if none, `NO_POSTING_RULE` 422 |
| Preview called with missing amount role | `MISSING_AMOUNT_ROLE` 422 naming the role |

### Thai tax (WS3.1)
| Scenario | Behaviour |
|----------|-----------|
| VAT return already filed for period | `ALREADY_FILED` 409 |
| WHT remittance past due | Mark `tax_calendar.status='overdue'`; surface in dashboard alert |
| Missing seller VAT number | `SELLER_VAT_REQUIRED` 422 |

### Revenue recognition (WS3.4)
| Scenario | Behaviour |
|----------|-----------|
| SSP allocation doesn't sum to total | Auto-normalise by proportional scaling; log warning |
| Recognition on cancelled contract | `CONTRACT_CANCELLED` 422 |
| Milestone condition empty for milestone method | `MILESTONE_CONDITION_REQUIRED` 422 |

### General infrastructure
| Scenario | Behaviour |
|----------|-----------|
| DB timeout / connection error | NestJS propagates as 503; do NOT catch and swallow |
| Raw JS `Date` in Drizzle `sql` template | Crashes prod postgres-js — **never do this**; pass string |
| Null in numeric calc | Use `n()` helper from `database/queries` everywhere; treats null as 0 |
| `tenantId` null in postEntry | Warn + reject; entry with null tenant escapes RLS |

---

## 5. Sequential Implementation Plan (Master Plan)

Each step = one PR. Branch from `main`, implement, verify (build + harness), open PR, merge --squash.

### Step 1 — WS1.1: CoA master data
**Files to create:** `coa.service.ts`, `coa.controller.ts`
**Files to modify:** `ledger.ts` (schema), `ledger.service.ts` (postEntry guard), `ledger.module.ts`,
  `permissions.ts`, `0155_coa_master.sql`, `meta/_journal.json`
**Files to create (docs):** update `docs/process-narratives/04-general-ledger-close.md` (CoA section),
  `docs/uat/05-general-ledger-close-uat.md` (2 UAT cases), `compliance/build_rcm.py` (GL-11)
**Verify:** `pnpm --filter @ierp/api build`, extend `basics` harness, `pnpm --filter @ierp/cutover basics`
**Exit criteria:** CoA editable via API; postEntry rejects inactive/non-postable accounts; GL-11 in RCM

### Step 2 — WS1.2: Posting engine
**Files to create:** `posting.service.ts`, `posting-rules.controller.ts`, `posting-rules.ts` (schema)
**Files to modify:** `ledger.module.ts`, `0156_posting_rules.sql`, `meta/_journal.json`
**Key deliverable:** golden-snapshot parity test in `basics` harness (all event types preview == current literals)
**Do NOT migrate callers yet** — that's a follow-on per-module PR series after this foundation lands.
**Verify:** golden snapshot green, `pnpm -r typecheck`, `pnpm --filter @ierp/api build`

### Step 3 — WS1.3: Multi-dimensional postings
**Files to modify:** `ledger.ts` (journalLines), `0157_gl_dimensions.sql`, `meta/_journal.json`,
  `ledger.service.ts` (trialBalance/incomeStatement/balanceSheet filter + by-branch P&L),
  `PostingService` (stamp dims from context)
**New endpoint:** `GET /api/ledger/income-statement/by-branch`
**Web page:** branch selector on `/accounting` using existing `DataTable`
**Verify:** basics harness — 2 branches post, by-branch P&L splits correctly and sums to consolidated

### Step 4 — WS1.4: Sub-ledger control accounts + tie-out
**Files to create:** `subledger_tieout_runs` schema, service method `subledgerTieOut`, endpoints
**Files to modify:** `ledger.service.ts` `postEntry` (control-account guard), `0158_subledger_tieout.sql`
**Verify:** basics — direct post to 1100 → CONTROL_ACCOUNT 422; AR invoice posts via subledger → tieout = 0

### Step 5 — WS2.1: Hard period close + checklist
**Files to create:** `close.service.ts`, `close.controller.ts`, `close.ts` (schema),
  `0159_period_close.sql`
**Files to modify:** `ledger.service.ts` (`postEntry` — remove `allowClosedPeriod` escape; change Locked
  period to hard 422), `ledger.module.ts`
**Important:** seeds must post within open periods; replace any `allowClosedPeriod:true` calls in test
  seeds with `openPeriod` before seeding.
**Verify:** worldclass year-end harness stays green; late post to locked period → PERIOD_LOCKED 422

### Step 6 — WS2.2: GL immutability
**Files to modify:** `0160_gl_immutability.sql` (trigger + gl_audit_log), `ledger.ts` (add columns),
  `ledger.service.ts` (reverseEntry method, stamp posted_at)
**New endpoint:** `POST /api/ledger/entries/:entryNo/reverse`, `GET /api/ledger/audit-log`
**Verify:** compliance harness — UPDATE posted entry → DB throws; reversal nets to zero

### Step 7 — WS2.3: AR/AP operational controls
**Files to modify:** `0161_ar_ap_controls.sql`, `finance.ts` (schema), `finance.service.ts` (credit hold
  gate, allowance method), `collections.service.ts` (dunning gate),
  `payments.service.ts` / `payments-depth.service.ts` (3-way match payment gate)
**Verify:** basics — credit-hold order rejected; allowance posts contra-AR; AP pay blocked without match

### Step 8 — WS3.1: Thai tax filing pack
**Files to create:** `tax-filing.service.ts`, `tax-filing.controller.ts`, `0162_thai_tax_filing.sql`
**Files to modify:** `tax-docs.ts` (schema), `tax.module.ts`
**Verify:** taxdocs harness — VAT return = Σoutput − Σinput; WHT aggregates by form; calendar flags overdue

### Step 9 — WS3.2: Deferred tax + period-end FX reval
**Files to create:** `deferred-tax.ts` (schema), `0163_deferred_tax_fx_reval.sql`
**Files to modify:** `ledger.service.ts` (accrueDeferredTax, revalueOpenItems), close checklist (WS2.1
  steps: add 'deferred_tax' and 'fx_reval' as required close steps)
**New accounts in COA:** 1700 (DTA), 2700 (DTL), 5950 (deferred-tax expense) — add to `COA` array + seed
**Verify:** worldclass — reval moves AR by rate delta; deferred tax = temp_diff × rate

### Step 10 — WS3.3: Consolidation eliminations + segment reporting
**Files to create:** `segments.ts` (schema), `0164_consol_elim_segments.sql`
**Files to modify:** `consolidation.service.ts` (generateEliminations, segmentReport)
**Verify:** worldclass — IC entity sale: 1150/2150 net to zero after elimination; segment report sums total

### Step 11 — WS3.4: Revenue recognition TFRS 15
**Files to create:** `revrec.ts` (schema), `0165_revrec_tfrs15.sql`, service + controller in `revenue/`
**Files to modify:** `revenue.service.ts` (add allocateBySSP, recognize, accrueRefundLiability),
  `revenue.module.ts`
**Verify:** basics — 2-element contract allocates by SSP ratio; over-time recognizes pro-rata per period

---

## Migration journal template (append to `meta/_journal.json` for each WS)
```json
{ "idx": <NEXT>, "version": "<NNNN>_<name>", "when": <last_when + 1>, "tag": "<NNNN>_<name>" }
```
Last known: idx 154, when 2023720000004. Increment both by 1 for each new migration.
Journal uses CRLF line endings. Never duplicate idx.

## New permissions to add (in order, `packages/shared/src/permissions.ts`)
- WS1.1: `'gl_coa'` — CoA management (create/deactivate accounts; perm group `Finance & AR/AP`)
- WS1.2: `'gl_posting_rules'` — posting rules management
- WS2.1: reuse `'gl_close'` for close checklist; no new perm needed
- WS3.1: reuse `'exec'` + `'ar'` for tax filing

## RCM controls to add per WS (run `python3 compliance/build_rcm.py` after each WS)
WS1.1 → GL-11 | WS1.2 → GL-12 | WS1.3 → GL-13 | WS1.4 → GL-14
WS2.1 → GL-15, GL-16 | WS2.2 → GL-17 | WS2.3 → AP-03
WS3.1 → TAX-05 | WS3.2 → GL-18, TAX-06 | WS3.3 → CON-02, CON-03 | WS3.4 → REV-15
