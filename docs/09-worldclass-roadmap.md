# 09 — World-Class / Global Upgrade Roadmap

> **⚠️ SUPERSEDED — HISTORICAL GAP REVIEW (banner added 2026-07-02, docs/27 R3-2 / AUD-CMP-02).**
> This document is a point-in-time review from **before** the hardening programs landed and several of its
> central "honest verdict" claims are now **false as current-state statements** — kept unedited as history:
> - "tenant isolation designed but **not enforced** / RLS grep returns zero hits" → RLS is DB-enforced with
>   `FORCE ROW LEVEL SECURITY` + fail-closed prod behavior (`apps/api/drizzle/0002_rls.sql`,
>   `common/tenant-tx.interceptor.ts`) and is ToE-tested (`tenant-isolation`, `pg-smoke`).
> - "no general ledger / no payment capture" → full GL with maker-checker + DB-level posted-JE immutability
>   (`modules/ledger`, `0165_gl_immutability.sql`), payments/PSP integrations shipped.
> - "no signup, no billing" → self-serve signup + Stripe subscription billing (`modules/billing`).
> - "no MFA/SSO", "no ML, no RAG, no evals, no PII redaction, hard-coded Opus" (§AI) → TOTP MFA + OIDC SSO;
>   demand-ml + RAG + CI-gated `ai-eval` + `pii-redact` + model tiering/budgets (`common/ai-models.ts`).
> For current state read `compliance/CONTROL_STATUS_HONEST.md`, `docs/27-angel-audit-remediation-plan.md`
> §0, and the per-cycle process narratives. The *roadmap framing* below (T0–T3 sequencing, go-to-market
> tiers) remains useful as strategy history; treat every "current state" assertion as stale.
>
> Multi-lens architecture review (8 domain experts) of Invisible ERP V2 vs SAP/NetSuite/Odoo (ERP) and Square/Toast/Shopify (POS). Synthesized executive roadmap + per-area detail.

All eight reviews independently converge on the same root cause (unenforced RLS), so I have what I need to synthesize without further file checks.

# Invisible ERP V2 — Executive Upgrade Roadmap to World-Class / Global

## 1. Honest verdict

Today this is a **well-engineered Thai sales-order system with an AI copilot bolted on cleanly** — not yet an ERP, not yet a POS, and not yet a SaaS product. The engineering instincts are genuinely senior (atomic transactions, surrogate keys, parity-tested migration, deny-by-default auth, numeric money columns), but three structural facts cap it hard: tenant isolation is **designed but not enforced in the database** (one forgotten `WHERE` = cross-tenant breach), there is **no general ledger and no payment capture** (so it's a tracker and an order-recorder, not accounting or point-of-sale), and there is **no way for a stranger to become a paying customer** (no signup, no billing). The realistic path is not a rewrite — it's a disciplined 12–18 month sequence that hardens the foundation (RLS, GL, payments, CI gates), then platformizes (self-serve + billing + public API), then globalizes (currency/tax/i18n engine), with the AI-agentic angle as the differentiator layered on top once the books and isolation are trustworthy.

## 2. The 7 highest-leverage moves (ranked)

| # | Move | What | Why it's the gate to world-class/global | Effort |
|---|------|------|------------------------------------------|--------|
| **1** | **Enforce Postgres RLS at the connection layer** | Per-request transaction with `SET LOCAL app.tenant_id`, non-superuser app role, `FORCE ROW LEVEL SECURITY`, transaction-pinned pool | Five separate reviews flag this as *the* disqualifying finding. Until the DB physically cannot return another tenant's row, no auditor, SOC 2 assessor, or serious buyer proceeds — and it blocks residency, tiering, billing, and the agent's tenant-scoping. Lowest-effort, highest-stakes fix in the whole system. | **M** |
| **2** | **Build the double-entry General Ledger** | `accounts` / `journal_entries` / `journal_lines`, balanced-by-construction; AR/AP/POS/inventory *post into it*; add period-close + immutability | This converts a "POS add-on" into an "ERP." Trial Balance, Balance Sheet, Cash Flow, multi-currency, tax, and fixed assets are all *downstream of the GL and impossible to bolt on without it*. The current `pl()` is a non-compliant SQL sum that fails GAAP/IFRS. | **L** |
| **3** | **Build the payments + tender layer** | `payments` table (1 sale → N tenders) behind a gateway abstraction; Stripe Terminal/Adyen + PromptPay QR; auth→capture→settlement webhooks; refunds/voids/till sessions hang off it | A sale currently closes on a free-text `paymentMethod` string with zero proof money moved — it fails any retail buyer's first demo. Everything POS (split tender, refunds, X/Z reports, reconciliation) requires a real money-movement record. | **L** |
| **4** | **Promote the 5 test harnesses to required CI gates + add observability** | Wire read/write/analytics/e2e/ext suites + coverage into `ci.yml`; add OpenTelemetry tracing, Sentry, structured `pino` logs with trace+tenant correlation | Today a green check means "it compiles," not "it works" — the #1 technical-DD red flag, and the tests *already exist and pass*. You cannot operate 99.95% blind. This is the cheapest credibility win (≈days) and the gate every later upgrade hangs on. | **S/M** |
| **5** | **Currency + tax abstraction on every money row** | ISO-4217 currency column (integer minor units) + `fx_rate`/`fx_date`; replace hard-coded `VAT_RATE=0.07` with a `TaxProvider` interface (first adapter returns Thai 7%) | The hard-coded VAT and implicit-THB model are *spreading* into every new order/invoice/report. Doing this now converts "global support" from a future rewrite into a future *adapter* — and it's a prerequisite for the GL and e-invoicing. | **M** |
| **6** | **Self-serve tenant lifecycle + subscription billing** | Signup → email verify → automated tenant provisioning (with RLS on) → Stripe Billing (plans, trials, metering, dunning, Stripe Tax) | This is the line between *software* and *a SaaS business*. Right now there is no way to charge anyone; onboarding is an operator inserting an integer. It also forces the two latent blockers (RLS, payments) to the surface. | **M** |
| **7** | **Public versioned API + edge security + SSO/MFA** | `/api/v1/*` with OpenAPI 3.1, scoped API keys, signed retryable webhooks; `@fastify/rate-limit` + `helmet` + WAF; OIDC/SAML + SCIM + TOTP; append-only audit log | The ecosystem *is* the moat vs Odoo/Shopify, and SSO/SCIM unlocks every mid-market+ deal. Rate-limiting an unthrottled `/login` and a tamper-evident audit trail are baseline trust artifacts procurement demands. | **M/L** |

## 3. Tiered roadmap

| Tier | Theme | Key items | Outcome |
|------|-------|-----------|---------|
| **T0** | **Table-stakes to credibly be ERP/POS** | RLS enforced in DB; double-entry GL + COA + financial statements + period close; payments/tender layer; refunds/voids/till sessions; perpetual-inventory ledger (atomic stock-at-checkout); 5 CI gates + tracing/logs; currency+tax abstraction; rate-limit/helmet/audit-log; agent tenant-scoping + guardrails; forecast backtesting harness (WAPE/MASE) | The system is *actually* an auditable ERP and a real POS that can't oversell, leak tenants, or close a sale without captured money. Passes a first technical-DD and security review. |
| **T1** | **World-class core** | SSO/SAML + SCIM + MFA + token rotation; tenant-isolation tiers (pool / schema-per-tenant / DB-per-tenant); Redis + read replicas + partitioning + outbox/broker; immutable financial audit trail; secrets mgmt + KMS field encryption; PDPA/GDPR DSAR + retention; SBOM/SAST/dep-scanning CI gates; real i18n (ICU/next-intl); Playwright E2E; OpenAPI + versioning; SLOs/error budgets + tested DR; status page/SLA/support tiers; real demand model (seasonality/Croston via Nixtla); analytics plane (dbt + semantic layer + embedded BI); agent eval suite | Trustworthy at scale: survives enterprise security questionnaires, multi-region load, and frontend refactors. Lands regulated/mid-market logos. |
| **T2** | **Global expansion** | Multi-currency ledger (functional/transaction/reporting + FX revaluation); pluggable tax engine (Avalara/Stripe Tax) + e-invoicing adapters (Peppol/India IRN/Italy SdI/CFDI/Thai RD e-Tax); data-residency routing (region→cluster); accounting + e-commerce connectors (QuickBooks/Xero, Shopify/Woo); SOC 2 Type II + ISO 27001 + pen-test; PCI-DSS scope design (SAQ-A); KDS for F&B; UoM + libphonenumber + structured addresses; fraud/payment-anomaly scoring | Legally and operationally sellable in EU/US/APAC. Transacts in any currency, clears any mandate, satisfies residency law. |
| **T3** | **Differentiators (AI-agentic ERP)** | **Agentic *write* ops** (create the PO, not just suggest — behind RBAC + human-in-the-loop + immutable audit); RAG over ERP docs/policies/SOPs/contracts (pgvector, cite-or-refuse); inventory valuation→COGS (FIFO/weighted-avg cost layers); fixed-assets + depreciation; developer portal + app marketplace (revenue share); BYOK/customer-managed keys; country localization packs (Odoo l10n model) | The thing competitors can't copy quickly: an ERP that *does the work*, governed and auditable, on top of trustworthy books and isolation. |

## 4. Sequenced plan

**Now (0–3 mo) — "Make it trustworthy and real."** *Do not platformize on a leaky foundation.*
1. **Enforce RLS** at the connection layer (move #1) — unblocks everything.
2. **Wire the 5 CI gates + coverage**, add OpenTelemetry + Sentry + pino (move #4) — ≈1 week, instant DD credibility.
3. **Edge hardening**: `@fastify/rate-limit`, `helmet`, body-size limits, append-only `audit_log` interceptor.
4. **Currency+tax abstraction** on every money row before more transaction types are written (move #5).
5. **Agent tenant-scoping + guardrails** (pass `tenantId` into every tool exec; output validation; PII redaction; model routing Haiku/Sonnet to kill 15-Opus-turns cost) and the **forecast backtesting harness** (turns "we have forecasting" into a defensible number).
6. Start the **GL design** (schema + posting model) — long pole, begin now.

**Next (3–9 mo) — "Make it an ERP, a POS, and a business."**
1. **Ship the GL** + COA + Trial Balance/BS/IS/CF + period close (move #2); migrate AR/AP/POS to post into it.
2. **Ship payments/tender** (move #3) + refunds/voids + till sessions + **perpetual-inventory ledger** with `FOR UPDATE` (kills oversell).
3. **Self-serve signup → provisioning → Stripe Billing** (move #6).
4. **Public `/api/v1` + OpenAPI + API keys + signed webhooks** (move #7, part 1) and **SSO/SAML + SCIM + MFA** (part 2).
5. Redis + read replica + outbox; Playwright E2E; secrets→KMS; PDPA DSAR/retention; status page + SLOs + tested DR drill.

**Later (9–18 mo) — "Make it global and differentiated."**
1. **Multi-currency ledger + pluggable tax engine + e-invoicing adapters** (T2) — the real "global" unlock, now an adapter not a rewrite.
2. **Data-residency routing + tenant-isolation tiers**; QuickBooks/Xero + Shopify connectors; SOC 2 Type II + ISO 27001 + pen-test.
3. **Real demand ML** (Nixtla/Prophet sidecar) + analytics plane (dbt + Cube + Metabase) + agent eval suite as CI gate.
4. **The differentiator**: **agentic write-ops with approvals + audit**, RAG over policies/contracts, COGS/fixed-assets, and the **developer marketplace**.

## 5. The strategic bet (one line, opinionated)

**Win as "the ERP that runs itself" — the first ERP/POS where a governed AI agent doesn't just answer questions but *executes the back-office* (raises the PO, posts the journal, reconciles the till, files the tax) with every action double-entry-auditable and tenant-isolated by construction — so a 5-person Bangkok shop gets a CFO-grade finance team and a global enterprise gets an auditor it can trust; the agent is the wedge, but trustworthy books + DB-enforced isolation are the moat that makes incumbents (Odoo/NetSuite, whose AI is thin) unable to follow.**

---

# Appendix — Per-area expert reviews


======================================================================
# Accounting & Finance core
======================================================================
# Accounting & Finance Core — Readiness Review

## 1. What's already solid

- **Sub-ledger plumbing is real and atomically correct.** `createReceipt` (finance.service.ts:97–113) wraps the receipt insert + invoice paid/status update in a single `db.transaction`, and AR/AP partial-payment math (`newPaid >= amount ? 'Paid' : 'Partial'`) is consistent across `createReceipt`, `createApTxn`, and `payAp`. Outstanding balances are computed as `amount - coalesce(paid_amount,0)` in SQL (finance.service.ts:43, 54), not in app code — the right instinct.
- **Document lifecycle has a paper trail.** Every state change routes through `StatusLogService.log(...)` (finance.service.ts:111, 126, 138) into `doc_status_log`, and AR invoice generation is idempotent — `syncArInvoices` guards on an `existing` set and `onConflictDoNothing` (finance.service.ts:77, 90), so re-runs won't double-bill.
- **Credit terms are honored per customer.** Due dates derive from `tenants.creditTerm` (finance.service.ts:84–88) rather than a global default, which is more than many early-stage systems do.
- **Money columns use `numeric(14,2)`**, not floats (finance.ts:13, 27, 45) — the one non-negotiable that's frequently gotten wrong is right here.

## 2. Critical gaps vs world-class

This is **not an accounting system** — it is two payment trackers (AR, AP) plus a SQL report that calls itself a P&L. Concretely:

- **No general ledger, no journals, no chart of accounts, no double-entry.** The `finance.ts` schema is three tables: `ar_invoices`, `ar_receipts`, `ap_transactions`. There is no `accounts`, no `journal_entries`, no `journal_lines`. Nothing in the system ever balances debits to credits. An auditor cannot trace a transaction to an account, and you cannot produce a trial balance — the foundational artifact of any audit.
- **The "P&L" is a query, not a statement.** `pl()` (finance.service.ts:22–37) defines profit as `sum(custPosSales.total) − sum(apTransactions.amount where status='Paid')`. That is **cash-basis on the AP side, accrual-ish on the AR side**, mixing the two illegally. "Expenses" = AP paid this month by due date; COGS, payroll, depreciation, accruals, and prepaids simply do not exist. `gross_profit` here is meaningless under both GAAP and IFRS.
- **No Balance Sheet, no Cash Flow Statement.** Only a P&L-shaped object and a KPI blob (finance.service.ts:60–69) exist. Without a GL you *cannot* generate a BS or CF — there are no account balances to roll forward.
- **No period close, no immutability.** Posted invoices and receipts are mutable rows (`db.update(...)` on `paidAmount`/`status`). There is no fiscal-period table, no lock, no "you cannot post into a closed month." This alone fails every financial audit.
- **No FX, no tax engine, no cost accounting.** `apTransactions.currency` defaults to `'THB'` and is never converted; AR has no currency column at all. VAT is hard-coded 7% upstream. No fixed-asset register, no depreciation, no inventory valuation feeding COGS (inventory is snapshot-based, so there is no perpetual cost layer to draw from).
- **Weak referential integrity for books.** `apTransactions.vendorName` is denormalized and matched "by name OR id" (finance.ts:39) — fine for a tracker, unacceptable for ledgers where every line must tie to a controlled account/party.

## 3. Concrete upgrades

| Upgrade | Why it matters globally | Tech/approach | Effort | Tier |
|---|---|---|---|---|
| **Double-entry GL**: `accounts`, `journal_entries` (header), `journal_lines` (debit/credit, balanced) | The entire definition of an auditable ERP; everything else derives from it | Append-only journal tables; DB `CHECK`/trigger enforcing `sum(debit)=sum(credit)` per entry; post AR/AP/POS/inventory as journals | L | **T0** |
| **Chart of Accounts + sub-ledger control accounts** | AR/AP must reconcile to a GL control account; basis for BS | Seed COA per tenant; map existing `ar_invoices`/`ap_transactions` to control accounts; reconciliation report | M | **T0** |
| **Financial statements from balances** (Trial Balance → BS → IS → CF) | Buyers/auditors ask for these on day one; current `pl()` is non-compliant | Derive from `journal_lines` rollups; replace the cash/accrual-mixed `pl()`; CF via indirect method | M | **T0** |
| **Period close + immutability** | "Books can't change after close" is table-stakes for any auditor | `fiscal_periods` table with status; reject posts into closed periods; reversing entries instead of edits | M | **T0** |
| **Immutable audit trail on financial rows** | SOC2/financial audit; today only `doc_status_log` exists | Append-only postings (no `UPDATE` on posted lines); who/when/before/after on every entry | M | **T1** |
| **Multi-currency**: transaction + functional + reporting currency, FX gain/loss | Required the moment a second country is in scope | Currency on every monetary row, daily rate table, realized/unrealized FX revaluation entries | L | **T2** |
| **Pluggable tax engine** (replace hard-coded 7% VAT) | Sell outside Thailand → per-jurisdiction VAT/GST/sales tax | Tax-code/rate tables per jurisdiction or Avalara/Stripe Tax integration; tax posted as GL lines | L | **T2** |
| **Inventory valuation → COGS** (FIFO/weighted-avg cost layers) | Real gross margin; ties inventory to GL | Perpetual cost layers feeding COGS journals on each sale (depends on a real inventory ledger) | L | **T3** |
| **Fixed assets + depreciation** | Complete BS; standard ERP module | `fixed_assets` + monthly depreciation journals (straight-line/declining) | M | **T3** |

## 4. If you do only ONE thing

**Build the double-entry general ledger** (`accounts` / `journal_entries` / `journal_lines`, balanced-by-construction) and make AR, AP, POS, and inventory *post into it* rather than living as standalone trackers. Everything an auditor or serious buyer demands — Trial Balance, Balance Sheet, Cash Flow, period close, multi-currency, tax, fixed assets — is downstream of the GL and **impossible to bolt on without it**. The current `finance.ts` (3 tables) and `pl()` (a non-compliant SQL sum) are a tracker masquerading as accounting; the GL is the one change that turns this from a POS add-on into an ERP.

======================================================================
# POS (world-class retail/hospitality)
======================================================================
Both files read in full. Here is the grounded review.

## POS Readiness Review — Invisible ERP V2

### 1. What's already solid

- **Clean transactional write path.** `PortalPosService.createSale` (`portal.pos.service.ts:56-92`) wraps sale header + line insert + inventory decrement + stock-log + loyalty accrual in a single `db.transaction`, so a sale is atomic. Line math (per-line discount, subtotal, VAT, total) is explicit and rounded consistently at `:36-45`.
- **Real B2B commerce guardrails.** `PosService.createOrder` (`pos.service.ts:102-111`) does a genuine credit check — `credit_hold` block plus live AR-outstanding (`sum(amount - paid_amount)` on unpaid invoices) vs `credit_limit`. That is more than most POS demos ship and is correctly enforced inside the order flow.
- **Auditable status transitions.** Orders run through a validated state machine (`ORDER_STATUSES`, `:11`, `:149`) with every transition written to a status log (`statusLog.log('SO', …)`, `:142`, `:158`). The `SALE-`/`SO-` doc numbering via `DocNumberService` gives stable, human-readable document IDs.
- **Loyalty earn is wired end-to-end** with balance + lifetime upsert and a `loyaltyTxn` ledger row (`:84-91`), parity-matched across both central and portal POS.

### 2. Critical gaps vs world-class

This is a **sales-order recorder, not a point of sale.** Against Square/Toast/Lightspeed it is missing the entire transaction tier that defines a POS:

- **No payments. At all.** `paymentMethod` is a free-text string (`:59`, defaulted to `'Cash'`). There is no tender capture, no gateway, no authorization/capture, no card/QR/PromptPay, no settlement, no reconciliation. A sale is marked `'Completed'` with zero proof money moved. This alone fails any retail buyer's first demo.
- **No tendering primitives:** no split payment, no partial tender, no change-due, no tip line. `total` is computed and the row is closed — there is no `payments` table at all.
- **No refunds/returns/voids flow.** Code only *filters out* `status='Voided'` (`:107`, `pos.service.ts:29`); there is no void/refund **operation**, no reversing stock movement, no reversing loyalty txn, no manager-auth/reason-code audit. A returned item silently corrupts inventory and points.
- **Inventory at checkout is unsafe.** `createSale` decrements with `Math.max(0, current - qty)` (`:74`) and reads-then-writes with **no row lock and no oversell guard** — two concurrent sales of the last unit both succeed and stock floors at 0. And per the verified state, this is a snapshot table, not a perpetual ledger, so checkout stock is not authoritative.
- **No till/shift/cash management.** `sessions()` (`pos.service.ts:79-86`) is a *query that groups completed sales by cashier+date* — it is not a till session. No open/close, no opening float, no cash-drop, no blind count, no over/short, no X/Z report.
- **No hardware, no offline, no fiscalization, no KDS.** No receipt-printer/cash-drawer/scanner/terminal integration; POS is online-only (a dropped connection = no sales); no fiscal receipt / e-Tax Invoice (Thai RD), no multi-store routing. VAT is hard-coded `0.07` (`:13`) — unusable outside Thailand.
- **Tenant isolation is app-code only.** `createSale` trusts `portal.tenantId(user)` with no DB-level RLS; a query bug leaks cross-tenant POS data.

### 3. Concrete upgrades

| Upgrade | Why it matters globally | Tech / approach | Effort | Tier |
|---|---|---|---|---|
| Payments + tender model | Without it this is not a POS | `payments` table (1 sale → N tenders); Stripe Terminal / Adyen; QR via **PromptPay EMVCo**, Alipay+/WeChat; auth→capture, webhooks for settlement | L | **T0** |
| Refunds / returns / voids with audit | Buyers/auditors require reversibility | Reversing sale + stock + loyalty txns; manager PIN, reason codes, immutable audit trail | M | **T0** |
| Till / shift / cash session | Cash retail can't operate without it | `pos_session` (open float, drops, blind close, over/short) + X/Z reports | M | **T0** |
| Atomic stock-at-checkout | Prevent oversell / negative inventory | Perpetual movement ledger + `SELECT … FOR UPDATE` (or conditional `UPDATE … WHERE qty>=`); reservation on add-to-cart | M | **T1** |
| Offline-first + sync | Toast/Square run through outages | Local store (IndexedDB/SQLite) + idempotent ops + CRDT/last-writer reconcile + sync queue | L | **T1** |
| Hardware layer | Real lanes need it | OPOS/JavaPOS or **WebUSB/WebHID**; ESC/POS printers; cash drawer kick; Stripe/Adyen terminal SDK | L | **T1** |
| Tax engine + fiscalization | Removes hard-coded 7% VAT ceiling | Pluggable tax (Avalara/Stripe Tax); Thai **e-Tax Invoice/RD**, EU fiscal, multi-currency | L | **T2** |
| KDS for F&B | Required to sell into hospitality | Order-routing service + SSE/WebSocket KDS screens, course/fire timing | M | **T2** |
| DB-enforced RLS | Multi-tenant trust boundary | Postgres RLS policies on `tenant_id` (already designed in docs/03) | S | **T1** |

### 4. If you do only ONE thing

**Build the payments + tender layer** — a real `payments` table (one sale → many tenders) behind a gateway abstraction, starting with Stripe Terminal/Adyen plus PromptPay QR, with auth→capture and settlement webhooks. Everything else here (refunds, split tender, till reconciliation, fiscal receipts) hangs off a real money-movement record. Until a sale at `portal.pos.service.ts:56` is backed by a captured tender instead of a free-text `paymentMethod` string, this is an order-entry system, not a POS — and no serious retail or hospitality buyer will get past the first demo.

======================================================================
# Multi-tenancy, data model & scale
======================================================================
I've grounded this in the three files. Here's the assessment.

## Multi-tenancy, Data Model & Scale — Readiness Review

### 1. What's already solid

- **The schema-design reasoning is genuinely senior.** `docs/03-database-schema.md` §0 shows the team correctly reverse-engineered a no-PK, denormalized SQLite legacy (`tbl_sales_orders` with no PK, CSV-serialized `Permissions`/`Item_IDs`, `Q1-3` fixed columns) into a clean relational model: surrogate `bigserial` PKs, real FKs, Postgres enums, header/line splits (`orders`+`order_lines`+`order_claims`), and EAV/`jsonb` where appropriate. This is the right instinct.
- **Tenant key was consolidated correctly.** The legacy had *two* competing tenant keys (`Customer_Name`, `Owner_Customer`); §0.2 and the mapping table (§11) collapse both into one `tenant_id bigint REFERENCES tenants(id)`. `tenants.ts` cleanly implements the surrogate-id + legacy-`code` pattern. One canonical tenant key is the foundation everything else needs.
- **The item-master / stock-fact split is the right call for a 1.48M-row table.** §0.3 splits the overloaded `tbl_raw_inventory` into `items` (master) + `stock_snapshots` (`PARTITION BY RANGE (generate_date)`, indexed `(item_id, generate_date DESC)`) + a `current_stock` view. Partitioning is *designed in* at the one table where it actually matters.

### 2. Critical gaps vs world-class

- **RLS is documentation, not enforcement — this is the headline finding.** §2.2 and §7 specify `current_setting('app.tenant_id')` policies, but `database.module.ts` builds a single Drizzle client over a shared `postgres-js` pool (`max=10`) with **no per-request `SET app.tenant_id`, no `SET ROLE`, no transaction-scoped session var**. Tenant isolation is therefore enforced *only* by a `WHERE tenant_id = ?` that app code must remember on every query across 72 tables. One missing predicate = cross-tenant data leak. For a multi-tenant ERP holding competitors' financials, this is the single fact that ends an enterprise security review or SOC 2 audit. The connection-pool design actively blocks the documented fix: a pooled connection can't safely hold a per-tenant session var without transaction-pinning.
- **Shared-row model with no isolation tier story.** Everything is shared-row `tenant_id`. There's no schema-per-tenant or DB-per-tenant option for the large/regulated customers a global ERP *must* land (a German manufacturer will not accept its GL in the same rows as a competitor). World-class B2B ERP offers a tenancy *spectrum*; this offers one point on it, and the weakest-isolation one.
- **Snapshot inventory cannot scale to global txn volume or correctness.** `current_stock` = `WHERE generate_date = (SELECT max(generate_date) FROM stock_snapshots)`. Current quantity is the *latest periodic snapshot*, and `stock_movements` is explicitly an audit log ("ไม่ปรับ stock_snapshots", line 109). There is no real-time perpetual ledger — you cannot answer "what is on hand *now*" between snapshots, cannot do atomic reservations, and the `MAX(generate_date)` subquery scans across all partitions on every read. Square/SAP do continuous perpetual inventory; this is a batch report masquerading as live stock.
- **Zero scale infrastructure.** Single Postgres, `DB_POOL_MAX=10`, single Railway region. No Redis, no read replicas, no live partitioning beyond the one designed table, no queue depth (pg-boss is "light"). At thousands of tenants and millions of txns, `MAX(generate_date)` reads, on-the-fly P&L computation, and a 10-connection pool are the first three things to fall over. Noisy-neighbor is unmitigated — one tenant's report run degrades everyone.
- **No data-residency primitive.** A global app needs EU/Thai-PDPA/per-country residency. There is no region column, no sharding key, no DB-per-region routing — `database.module.ts` reads one `DATABASE_URL`. Data residency is effectively impossible to retrofit onto a single shared instance without re-architecting tenancy first.

### 3. Concrete upgrades

| Upgrade | Why it matters globally | Tech / approach | Effort | Tier |
|---|---|---|---|---|
| Enforce RLS at the connection layer | Turns documented isolation into a DB-guaranteed invariant; removes "one forgotten WHERE = breach" | Per-request transaction with `SET LOCAL app.tenant_id`; non-superuser app role + `FORCE ROW LEVEL SECURITY`; NestJS request-scoped tx middleware wrapping Drizzle; switch pool to transaction-pinned | M | T0 |
| Perpetual-inventory ledger | Real-time on-hand, atomic reservations, auditability; table-stakes for POS/WMS | Append-only `inventory_transactions` (signed qty, lot, location) + running balance materialized view; keep snapshots as reconciliation only | L | T0 |
| Tenant-isolation tiers | Land regulated/enterprise logos that reject shared-row | Pool model (shared-row+RLS) for SMB; **schema-per-tenant** for mid-market; **DB/cluster-per-tenant** for enterprise; a tenant→connection router resolves at request time | L | T1 |
| Caching + read replicas | Offload P&L/KPI/`current_stock` reads; cut noisy-neighbor | Redis (cache-aside + idempotency keys); Postgres physical read replica; route reporting/analytics to replica | M | T1 |
| Data-residency routing | Legal prerequisite to sell in EU/regulated APAC | `region` on tenant; region→DB-cluster routing in `DatabaseModule` (replace single `DATABASE_URL`); Citus or per-region clusters | L | T2 |
| Time-partition the hot append tables | Keep `stock_snapshots`/ledger/`doc_status_log` fast at billions of rows | `pg_partman` monthly partitions + retention; partition pruning on `generate_date`/`created_at` | M | T1 |
| Durable async backbone | Decouple posting, reports, AI, webhooks under load | Promote pg-boss → outbox pattern + a broker (e.g. Redis Streams / SQS) for fan-out; per-tenant queue fairness | M | T1 |
| Tenant-aware rate limiting / quotas | Hard guarantee against noisy-neighbor | Token-bucket per `tenant_id` at the API gateway (Redis); connection quotas per tier | S | T2 |

### 4. If you do only ONE thing

**Enforce RLS at the connection layer** — wrap every request in a transaction that issues `SET LOCAL app.tenant_id`, run the app as a non-superuser role with `FORCE ROW LEVEL SECURITY`, and pin the pool per-transaction. The policies are already written in `docs/03`; the only thing standing between you and DB-guaranteed tenant isolation is the session-variable plumbing that `database.module.ts` currently omits. Until this exists, the entire system's multi-tenant safety rests on developers never forgetting a `WHERE` clause across 72 tables — and no serious buyer, auditor, or SOC 2 assessor will accept that. It is the lowest-effort, highest-stakes move in this whole area, and it also unblocks the residency and tiering work that depend on a real tenant-routing layer.

======================================================================
# Security, compliance & trust
======================================================================
Confirmed. `main.ts` configures only CORS and an exception filter — no `@fastify/helmet`, no `@fastify/rate-limit`, no CSRF, no request-size limits, no secrets-manager bootstrap. The JWT in `auth.service.ts:41` embeds `customerName` but nothing in the DB layer enforces it. I have everything I need.

---

## Security, Compliance & Trust — Readiness Review

### 1. What's already solid
- **Auth is deny-by-default, not opt-in.** `JwtAuthGuard` (`apps/api/src/common/guards.ts:8`) is global — every endpoint requires a valid Bearer JWT unless explicitly `@Public`, and the comment explicitly flags that this closed a V1 hole where data endpoints were wide open. That's the correct posture and a real improvement over the legacy app.
- **Password hygiene is modern.** `auth.service.ts:23-28` verifies via argon2/scrypt and *transparently rehashes legacy sha256 logins on successful auth* (`needsRehash`) — a genuinely well-engineered migration path most teams skip.
- **RBAC is centralized and capability-based.** 37 permission tokens resolved server-side via `resolvePermissions` (`auth.service.ts:39`) and checked in `PermissionsGuard` (`guards.ts:37`), with per-user overrides layered on role defaults. Tokens live in `@ierp/shared`, so web and API share one source of truth.
- **CORS is locked to explicit origins**, not V1's wildcard (`main.ts:12-13`) — small but it shows security-conscious intent.

### 2. Critical gaps vs world-class
These are the items that end an enterprise security review in the first hour:

- **Tenant isolation is a JWT claim with no enforcement floor.** The token carries `customerName` (`auth.service.ts:41`) and `PermissionsGuard` never reads it. Isolation depends entirely on every developer remembering to add `where(eq(tbl.tenantId, …))` in every query, forever. RLS was *designed* (docs/03) but **not implemented** — `grep` for `set_config`/`current_setting`/RLS across `apps/api/src` returns **zero hits**. One missing `WHERE` clause = cross-tenant data leak. For a multi-tenant global SaaS this is the single disqualifying finding: a pen-tester will find an IDOR within a day.
- **No MFA, no SSO.** Login is username/password only (`auth.service.ts:17`). Zero OIDC/SAML/SCIM. No enterprise buyer can provision via Okta/Entra/Google Workspace or enforce their own MFA policy — this alone blocks every mid-market+ deal.
- **No edge security middleware.** `main.ts` wires only CORS + an exception filter. No `@fastify/rate-limit` (credential-stuffing and brute-force the login at line 17 are unthrottled), no `@fastify/helmet`, no WAF, no request-size limits, no CSRF. JWTs appear long-lived with no refresh/rotation/revocation list visible.
- **No audit framework.** A `doc_status_log` table tracks document state, but there is no immutable, tamper-evident audit trail of *who-did-what-when* across auth, RBAC changes, exports, or PII access. SOC 2 CC7/CC8 and any forensic investigation require this.
- **No data-protection posture at all.** No field-level encryption / KMS for PII (customer names, contacts), no data-retention or right-to-erasure mechanism, secrets live in plain env vars (no Vault/cloud KMS). That's a hard fail against **GDPR** and **Thai PDPA** — and PDPA matters *now* given the Thai-centric customer base.
- **No payments security scope defined.** POS stores only a `payment_method` string, so there is no PCI-DSS exposure *today* — but the moment PromptPay/card capture is added with the current architecture, there is no SAQ-A redirect/tokenization boundary, no segmentation, nothing.
- **No third-party assurance.** No SOC 2 / ISO 27001, no pen-test, no SBOM/dependency-scanning in CI (CI does build+typecheck only), no vuln-disclosure policy. Procurement security questionnaires have nothing to point to.

### 3. Concrete upgrades

| Upgrade | Why it matters globally | Tech / approach | Effort | Tier |
|---|---|---|---|---|
| **Enforce tenant isolation in the DB** | Removes "one forgotten WHERE = breach"; the #1 auditor blocker | Postgres **RLS** policies on all tenant tables + `SET LOCAL app.tenant_id` per request via a Drizzle/Fastify hook; defense-in-depth with a base repository that injects `tenantId` | M | **T0** |
| **Rate limiting + security headers + WAF** | Stops brute-force/stuffing on `/api/login`; baseline hardening | `@fastify/rate-limit`, `@fastify/helmet`, body-size limits; Cloudflare WAF at edge | S | **T0** |
| **Audit logging framework** | SOC 2 CC7/CC8, PDPA/GDPR accountability, forensics | Append-only `audit_log` (actor, action, entity, before/after, IP) via Nest interceptor; ship to immutable store (S3 Object Lock) | M | **T0** |
| **SSO + SCIM + MFA** | Unlocks every enterprise deal; IdP-managed lifecycle | **OIDC + SAML 2.0** (Keycloak/WorkOS/Auth0), **SCIM 2.0** provisioning, **TOTP** (RFC 6238) for local accounts; short-lived JWT + refresh rotation + revocation | L | **T1** |
| **Secrets management + KMS field encryption** | No plaintext secrets/PII; key rotation | Move env secrets to **HashiCorp Vault / Railway+cloud KMS**; encrypt PII columns via **AWS/GCP KMS** envelope encryption (pgcrypto or app-layer) | M | **T1** |
| **GDPR/PDPA data-subject rights + retention** | Legal requirement in EU + Thailand | Consent registry, DSAR export/erasure endpoints, retention jobs (pg-boss), data-processing records | M | **T1** |
| **Supply-chain + CI security gates** | Table-stakes for any security questionnaire | **SBOM (CycloneDX)**, `pnpm audit`/**Snyk**/Dependabot, **CodeQL** SAST, secret-scanning (gitleaks) as CI gates | S | **T1** |
| **SOC 2 Type II + pen-test + ISO 27001** | The artifacts buyers literally ask for | Vanta/Drata for evidence automation; annual third-party pen-test; vuln-disclosure policy | L | **T2** |
| **PCI-DSS scope design (before payments ship)** | Keep card data out of scope from day one | Tokenized/redirect gateways (Stripe/Adyen/PromptPay PSP) → **SAQ-A**; never store PAN | M | **T2** |
| **Confidential-computing / customer-managed keys (BYOK)** | Wins regulated/large-enterprise tenants | Per-tenant KMS keys, tenant-scoped encryption, key-revocation = instant data lockout | L | **T3** |

### 4. If you do only ONE thing
**Implement and enforce Postgres Row-Level Security with a per-request `SET LOCAL app.tenant_id`.** Today, isolation between tenants rests entirely on every query in 72 tables carrying the right `WHERE tenant_id` — a single omission is a cross-tenant breach, and there is currently *nothing* in the database to catch it (grep confirms no RLS, no `set_config`). RLS turns "hope the developer remembered" into "the database physically cannot return another tenant's row." It is the one gap that, left open, makes a serious buyer or pen-tester walk away regardless of how good the rest looks — and unlike SSO or SOC 2, it's a structural fix you control entirely in-house.

======================================================================
# Internationalization & global readiness
======================================================================
I have grounded my assessment in the three required files plus the related currency/tax state. Here is the report section.

---

## Internationalization & Global Readiness

### 1. What's already solid
- **A real (if narrow) i18n seam exists.** `packages/shared/src/i18n.ts` centralizes UI labels in a typed `Record<string, {TH, EN}>` with a `navLabel(key, lang)` accessor and a deliberate TH-default fallback chain (`?.[lang] ?? ?.TH ?? key`). This is a clean place to swap in a proper catalog — the indirection is already there, not scattered `if lang==` checks.
- **Locale-correct money-in-words is handled for the home market.** `reports-export.service.ts` integrates the `bahttext` library with a graceful fallback (`bahtWords`), and the Express TXT export respects real-world integration constraints (fixed-width fields, `|` sections, CRLF for DOS ingestion, caller-added BOM). Whoever wrote this understands that localization is about *downstream system compatibility*, not just translation.
- **Status vocabularies are enumerated, not free-text.** `enums.ts` pins `orderStatus`, `poStatus`, `invoiceStatus`, `lotStatus` etc. as `pgEnum`s — a good foundation for the locale-independent state machines that any multi-country rollout depends on (you localize the *label*, not the *value*).

### 2. Critical gaps vs world-class
- **Tax is a hard-coded constant, not an engine.** `const VAT_RATE = 0.07` lives as a module global in `reports-export.service.ts` (and the field is literally labeled `padR('VAT7', 12)`). There is no jurisdiction lookup, no tax-code-per-line, no exemptions, no reverse-charge, no compound/multi-rate, no tax point/date logic. Selling into the US (5,000+ sales-tax jurisdictions), EU (VAT MOSS), or India (CGST/SGST/IGST) is impossible without a rewrite, not a config change.
- **Currency is implicitly THB everywhere and baked into output.** Money-in-words is *baht* (`bahttext`, `บาทถ้วน`), labels say `BAHTTEXT`. There is no currency column on transactions, no FX rate table, no functional-vs-transaction currency, no period-end revaluation. A serious ERP auditor stops here: you cannot post a foreign-currency invoice, let alone produce IAS 21 / multi-book financials.
- **i18n is a two-language nav dictionary, not a localization framework.** `i18n.ts` covers TH/EN *navigation labels only* — emoji are embedded in the strings, there's no ICU MessageFormat (no plurals/gender/number interpolation), no RTL, no per-locale date/number/address/phone formatting, no fallback locale negotiation, and the codebase comments themselves are Thai (`enums.ts`, the service header). Body content, errors (`messageTh` hard-coded inline), and reports are not in this catalog at all.
- **Zero e-invoicing/clearance capability.** The only "e-invoice" path is a proprietary fixed-width TXT for one Thai accounting package (Express). Nothing exists for Peppol BIS / EU mandates, Italy SdI, India GST IRP/IRN, LATAM CFDI, or even Thailand's own RD e-Tax Invoice & e-Receipt — all of which are *legal gating requirements*, not features, in their markets.
- **No locale data model.** No country, language, currency, UoM, or timezone reference tables; `pgEnum role` values are English magic strings; there is no tenant-level locale/currency/tax-jurisdiction configuration to drive any of the above.

### 3. Concrete upgrades

| Upgrade | Why it matters globally | Tech / approach | Effort | Tier |
|---|---|---|---|---|
| **Currency model on every money row** | Foreign-currency txns, consolidation, FX gain/loss — non-negotiable for any cross-border sale | Add `currency` (ISO 4217) + store **minor units as integers** (or `numeric`), `fx_rate`/`fx_date` per txn; functional vs transaction currency on the ledger | M | T0 |
| **Pluggable tax engine** | Replace `VAT_RATE=0.07`; handle US sales tax, EU VAT, GST, reverse-charge, exemptions | `TaxProvider` interface → adapters for **Avalara AvaTax** / **TaxJar** + an internal rate-table provider; tax code per line/product | L | T0 |
| **Real i18n framework** | Plurals, RTL, locale-correct dates/numbers/currency, fallback negotiation | **ICU MessageFormat** via FormatJS/`next-intl`; **`Intl.NumberFormat`/`DateTimeFormat`** for formatting; externalize all strings incl. errors; strip emoji from catalog | M | T1 |
| **e-Invoicing adapters per mandate** | Legally required to sell in EU/IN/IT/LATAM/TH | Pluggable `EInvoiceProvider`: **Peppol Access Point** (BIS Billing 3.0/UBL), **India IRP/IRN+QR**, **Italy SdI**, **CFDI 4.0**, **TH RD e-Tax** | L | T2 |
| **Locale & jurisdiction reference data + tenant config** | Single source of truth driving tax/currency/format per tenant & document | Seed `country`/`currency`/`uom`/`timezone` tables; tenant-level locale, functional currency, tax jurisdiction; store all timestamps **UTC `timestamptz`** | M | T1 |
| **UoM + address/phone normalization** | Global catalog, shipping, compliance | UN/CEFACT UoM codes + conversion table; **libphonenumber** for phones; structured (not free-text) addresses w/ country-driven formatting | M | T2 |
| **Country compliance/payroll packs** | Per-country statutory reporting, withholding, payroll | Modular per-country "localization pack" plugin pattern (the Odoo l10n model) | L | T3 |

### 4. If you do only ONE thing
**Introduce a currency + tax abstraction at the data and service layer before another transaction type is written.** The killer is not the missing features — it's that `VAT_RATE = 0.07` and an implicit-THB money model are *spreading*: every new order, invoice, and report (like `expressTxt`) hard-codes both. Add an ISO-4217 currency column with integer minor units to every money-bearing row, and replace the constant with a `TaxProvider` interface (even if the only initial adapter returns Thailand's 7%). This converts "global support" from a future rewrite into a future *adapter* — the single highest-leverage architectural move, and a prerequisite for the general ledger and e-invoicing work that follows.

**Files cited:** `C:/Users/ASUS/Invisible ERP V2/packages/shared/src/i18n.ts`, `C:/Users/ASUS/Invisible ERP V2/apps/api/src/database/schema/enums.ts`, `C:/Users/ASUS/Invisible ERP V2/apps/api/src/modules/reports/reports-export.service.ts`.

======================================================================
# Engineering maturity & reliability
======================================================================
Engineering maturity & reliability review based on the three grounded files (`.github/workflows/ci.yml`, `apps/api/src/app.module.ts`, `README.md`).

---

## Engineering Maturity & Reliability

### 1. What's already solid

- **Disciplined parity-first migration harnesses.** The README documents five distinct test harnesses running against *real* Postgres semantics via PGlite (read 10/10, write 24/24, analytics 14/14, e2e 16/16, ext 26/26), and the e2e suite actually *caught a real regression* — Nest's default `201` on `POST /login` vs. V1's `200`, fixed with `@HttpCode(200)`. Booting NestJS in-process and asserting side-effects (doc atomicity, lot ledger, auto-close, loyalty) is genuinely above-average rigor for a one-region app.
- **Clean, consistent CI scaffolding.** `ci.yml` is correct as far as it goes: pinned `actions/checkout@v4`, `pnpm/action-setup@v4`, Node 22 with pnpm cache, and `--frozen-lockfile`. The shared-package-then-typecheck-then-build ordering respects the monorepo's `@ierp/shared` dependency. This is a solid skeleton to hang gates on.
- **Security guards wired globally, not per-route.** `app.module.ts` registers `JwtAuthGuard` and `PermissionsGuard` as `APP_GUARD` providers, so auth+RBAC is default-deny across all 18 feature modules (opt-out via `@Public`), rather than opt-in per controller. That's the correct, audit-friendly default and closes a whole class of "forgot to protect the endpoint" bugs.
- **Atomic doc numbering as a deliberate correctness fix.** `DocNumberService` uses an upsert-returning counter table specifically to kill V1's `COUNT(*)+1` race — evidence the team reasons about concurrency, not just happy paths.

### 2. Critical gaps vs world-class

The single most damning fact: **`ci.yml` runs only `pnpm -r typecheck` and `pnpm -r build`. None of the five test harnesses are wired as CI gates.** A green check on this repo means "it compiles," not "it works." Those 16/16 e2e and 24/24 write suites can rot to zero on `main` and CI will stay green — for a serious buyer doing technical due diligence, untested-on-merge code that *claims* to be tested is worse than no tests, because the README asserts confidence the pipeline doesn't enforce.

Beyond that, the operate-at-scale story is effectively absent:
- **Zero observability.** Console logging only (per verified state). No OpenTelemetry traces, no RED/USE metrics, no Sentry, no structured logs with trace/tenant correlation. When a Thai customer's POS sale hangs at 02:00, there is no way to see *why* — no span, no error event, no latency histogram. You cannot operate, let alone SLO, what you cannot see.
- **No SLOs, no error budgets, no DR.** Single-region Railway Postgres, no documented RPO/RTO, no tested restore, no read replica. 99.95% global is four-nines-and-a-half; this architecture has no mechanism to *measure* uptime, no failover, and a backup story that is — as far as the docs show — untested. One region's outage = total outage.
- **No browser/E2E or coverage.** 22 Next.js routes, zero Playwright UI tests, zero coverage instrumentation. The login-redirect-by-role and live-VAT POS form are exactly the flows that silently break on a frontend refactor.
- **No API versioning / OpenAPI contract.** Paths are frozen at `/api/*` for parity but unversioned; no published OpenAPI spec, no contract tests. Any third-party integrator (the whole point of a "global ecosystem") is integrating against an undocumented, breakable surface.
- **No release safety.** No feature flags, no blue-green/canary (Railway `predeploy migrate` runs migrations inline — a bad migration is an instant prod outage with no traffic shift), no IaC (config is click-ops + env vars), no performance budgets.
- **The Playwright→PDF dependency is an operational landmine.** Reports lazy-load a headless Chromium "with graceful fallback." In a container that's a 300MB+ binary, a cold-start latency spike, and a class of crashes (missing libs, OOM) that *will* page someone — yet it's neither traced nor health-checked.

### 3. Concrete upgrades

| Upgrade | Why it matters globally | Tech/approach | Effort | Tier |
|---|---|---|---|---|
| Wire all 5 harnesses + coverage as CI gates | Green = "it works," not "it compiles" — the #1 DD red flag | Add `pnpm -r test` + `c8`/`vitest --coverage` jobs to `ci.yml`; fail PR under threshold; required status check | **S** | T0 |
| Distributed tracing + error tracking | Can't operate 99.95% blind; correlate across api↔web↔Postgres | OpenTelemetry SDK (auto-instrument Fastify/Drizzle) → OTLP to Grafana Tempo/Honeycomb; `@sentry/nestjs` | **M** | T0 |
| Structured logs w/ trace+tenant correlation | "Console only" is unsearchable at scale | `pino` (Fastify-native) JSON logs, inject `traceId`+`tenant_id`, ship to Loki/Datadog | **S** | T0 |
| Browser E2E on critical flows | Login-by-role, POS+VAT, checkout silently break on refactor | Playwright (already a dep) UI suite in CI against an ephemeral stack | **M** | T1 |
| OpenAPI contract + versioning | No integrator builds on an undocumented, breakable surface | `@nestjs/swagger` → spec artifact; `/api/v1`; Spectral lint + contract tests in CI | **M** | T1 |
| SLOs, RED/USE metrics, error budgets | Can't promise 99.95% you don't measure | Prometheus metrics endpoint, Grafana SLO dashboards, alerting on burn rate | **M** | T1 |
| Tested DR: backup + restore drill, RPO/RTO | "Backups exist" ≠ "restore works"; single region = single outage | Automated PITR (Postgres WAL), scheduled restore-verification job, documented RPO/RTO; read replica → multi-region path | **L** | T1/T2 |
| Blue-green/canary + decouple migrations | Inline `predeploy migrate` = instant outage on bad migration | Expand-contract migrations, traffic-shifted deploys (Railway envs or move to k8s/Argo Rollouts) | **L** | T1 |
| Feature flags | Ship dark, kill bad releases without redeploy | OpenFeature + Flagsmith/LaunchDarkly | **S** | T1 |
| IaC for all infra | Click-ops doesn't survive audit or multi-region | Terraform/Pulumi for Railway+DB+R2+secrets; move env→secrets manager | **M** | T2 |
| Outbox + CDC events | Integrations/webhooks/analytics need a reliable event spine | Transactional outbox table → Debezium/Postgres logical replication → broker | **L** | T2 |
| Harden/replace Playwright-PDF | Headless Chromium is a latency+crash+image-size liability | Move PDF render to an isolated worker/service w/ health checks + tracing; or Gotenberg/typst | **M** | T1 |

### 4. If you do only ONE thing in this area

**Promote the five existing harnesses (read/write/analytics/e2e/ext) to required CI gates in `ci.yml`, with coverage reporting.** The work is already done — the tests exist and pass; they are simply not run on merge. This is the highest-leverage move because it (a) converts a *claimed* quality bar into an *enforced* one in roughly a day, (b) removes the most obvious technical-DD red flag (a "tested" system whose pipeline only typechecks), and (c) creates the gate you'll hang every subsequent upgrade — coverage thresholds, Playwright E2E, contract tests — onto. Everything else in this section assumes a CI you can trust; right now you don't have one.

======================================================================
# Data, analytics & AI
======================================================================
I have enough grounding to write this section. The three files tell a clear story: well-structured TypeScript, but classic statistics dressed as "forecasting/anomaly," a single-LLM read-only tool-loop, and zero ML/eval/RAG infrastructure.

## Data, Analytics & AI

### 1. What's already solid
- **Clean, honest statistical baselines that actually run.** `forecasting.service.ts` implements a real reorder-point model — moving-average daily demand over a 30-day window, σ-based safety stock (`avg*leadTime + 1.5*stdev`), empirically-derived lead time from PO→GR date deltas (`leadTimeDays`, lines 42–53), and a sensible confidence ladder tied to data density (`series.length >= 30 ? 'high'…`). This is materially better than the "set a static min/max" that most SMB POS systems ship with.
- **The AI agent is grounded, not a hallucination box.** `agent.service.ts` enforces "ใช้ tool ดึงข้อมูลจริงก่อนตอบเสมอ" (always pull real data before answering) and wires 8 typed tools into a bounded Anthropic tool-loop (`MAX_LOOP_TURNS = 15`, `MAX_HISTORY = 40`) with real SSE token streaming (`stream()`, lines 82–156). Tool errors are caught and returned as data rather than crashing the loop (`exec`, lines 158–174).
- **Disciplined parity engineering.** Constants are deliberately frozen to match the legacy Python (`// parity` comments, `LOOKBACK=60, SAFETY=1.5`), so the TS rewrite is behavior-verified against the old app — rare discipline at this stage.

### 2. Critical gaps vs world-class
- **There is no ML — these are heuristics with a forecasting label.** No seasonality, no trend, no holiday/promo effects, no intermittent-demand handling (Croston's), no cross-item or hierarchical signals. A dense-zero-filled mean (`dailySales`, lines 31–39) will badly under-forecast spiky/seasonal SKUs. Anomaly detection is a 3-point z-score (`zscore`, lines 82–87) comparing a *recent sum* against a *per-day baseline* (the code even flags the unit mismatch: "เทียบ recent-sum กับ per-day baseline") — that is a known-wrong comparison preserved for parity. No fraud/payment-anomaly model exists at all.
- **No data platform.** Everything runs as live OLTP queries against the single Postgres (`db.select(...)` per item, N+1 in `getReplenishmentList`'s per-candidate loop, lines 92–95). There is no warehouse/lakehouse, no semantic layer, no embedded BI, no materialized features. This will not survive multi-tenant scale and gives auditors no governed reporting plane.
- **The agent is a single-model, read-only, single-tenant copilot.** No tenant scoping is passed to tools (`_user` is unused, line 42), so the agent leaks across tenants the moment RLS matters; no RAG over documents/policies; no write/approval actions (it can't *do* ops, only report); no eval suite, no guardrails, no prompt-injection defense on tool outputs, no PII redaction, no cost/latency budgeting, no caching, no model-tier routing. `claude-opus-4-8` is hard-defaulted (line 40) — premium model on every turn, up to 15 turns, no fallback.
- **No MLOps surface whatsoever.** No feature store, no model registry, no backtesting/accuracy tracking (MAPE/WAPE), no drift monitoring, no experiment framework. "Accuracy" is currently unmeasurable.

### 3. Concrete upgrades

| Upgrade | Why it matters globally | Tech / approach | Effort | Tier |
|---|---|---|---|---|
| Backtesting + accuracy harness (WAPE/MASE) around current forecaster | You cannot sell or improve a forecast you can't score; baseline-first is correct | Rolling-origin CV in TS; store error metrics per SKU; gate any model change on it | S | T0 |
| Per-tenant scoping + guardrails on the agent | Read-leak across tenants is an instant audit fail; injection via tool output is real | Pass `_user.tenantId` into every `exec` call; output schema validation; PII redaction; allow-list tools | S | T0 |
| Real demand model: seasonality + intermittent demand | Spiky/seasonal retail is where the heuristic loses money | StatsForecast/Nixtla (AutoETS, Croston, MSTL) or Prophet in a Python sidecar; serve via batch jobs (pg-boss) | M | T1 |
| Analytical plane + semantic layer + embedded BI | Auditors and ops need governed reporting that doesn't hammer OLTP | Postgres logical replication → DuckDB/ClickHouse or Snowflake; dbt models; Cube.js semantic layer; Metabase/Superset embed | L | T1 |
| Model routing, caching, cost/latency budget | 15 Opus turns/request won't scale or stay affordable | Haiku/Sonnet routing by intent; prompt caching; per-tenant token budgets + telemetry (Langfuse/Helicone) | M | T1 |
| Agentic *write* ops with approvals + audit | "Agentic ERP" only matters if it can create the PO, not just suggest it | Add write tools behind RBAC + human-in-the-loop confirm + immutable audit log | M | T3 |
| RAG over ERP docs/policies/SOPs | NL ops over contracts, supplier terms, tax rules is the real differentiator | pgvector + chunked embeddings; cite-or-refuse; eval set | M | T3 |
| Real-time fraud/payment anomaly scoring | Table-stakes once payments exist; the current z-score won't qualify | Streaming features + IsolationForest/GBM; rules+ML hybrid; tie to settlement events | L | T2 |
| Eval + regression suite for the agent | World-class AI ships with evals; none exist | Promptfoo/LangSmith golden tasks wired as a CI gate | M | T1 |

### 4. If you do only ONE thing
**Stand up a backtesting + accuracy harness (WAPE/MASE, rolling-origin) over the existing `forecasting.service.ts` and make it a CI gate.** It costs days, immediately tells you how good the current heuristic actually is, turns "we have forecasting" into a defensible number, and becomes the scoreboard that lets you safely swap in real ML (Nixtla/Prophet) later. Everything else in this area is unverifiable until you can measure forecast error — measurement is the unlock, not the model.

======================================================================
# Product, ecosystem & go-to-market
======================================================================
# Product, Ecosystem & Go-To-Market — Readiness Review

*Grounded in `C:/Users/ASUS/Invisible ERP V2/README.md` and `C:/Users/ASUS/Invisible ERP V2/MIGRATION_PLAN.md`, plus the verified Phase 0–8 state.*

## 1. What's already solid

- **A real, multi-domain product exists end-to-end.** README confirms 22 web routes and a full backend (POS, procurement, finance, BOM, marketing/loyalty, reports, AI) with a **customer portal as a tenant-scoped mini-ERP** (`modules/portal`, README Phase 7). Most "ERP platforms" pitching at this level have less working surface area.
- **The strangler-fig migration was executed with discipline.** `MIGRATION_PLAN.md` §4 plus README Phases 1–6 show ETL reconcile gates, read-parity diff (10/10), and a cutover runbook (`docs/08`) — this is the rigor a technical acquirer wants to see in a *codebase*, even if it doesn't yet translate to *platform* readiness.
- **The AI agent is genuinely integrated, not bolted on.** README Phase 5: an 8-tool Anthropic tool-loop calling the *real service layer* (not a passthrough), with rule-based fallback and SSE streaming. That is a credible differentiator vs. Odoo/NetSuite, whose AI stories are thin.
- **Path-stable, contract-aware API design.** Keeping `/api/*` paths and Zod validation (MIGRATION_PLAN §2) means there's a coherent HTTP contract to build a public API *on top of* — the foundation isn't hostile to platformization.

## 2. Critical gaps vs world-class

This codebase is **software, not a SaaS product.** Every pillar of a global platform GTM is absent — and the README's own "Deploy (Railway)" section makes clear the deployment model is single-tenant-operator, not self-serve SaaS:

- **No self-serve anything.** Onboarding is `db:seed` creating `admin/admin123` (README Quickstart). There is no signup, no tenant provisioning flow, no email verification — a tenant is an integer column an operator inserts. A buyer cannot try the product without you.
- **No billing/subscription layer.** No Stripe Billing, no plans, no metering, no trials, no dunning. There is no way to *charge* customers — the thing that makes it a business doesn't exist in code.
- **Zero ecosystem surface.** No public **versioned** API (`/api/*` is internal/unversioned), **no webhooks**, no OAuth app model, no API keys, no rate limiting, no developer portal, no marketplace. Square/Shopify/NetSuite *are* their ecosystems; this has none.
- **No external integrations at all** — no Stripe/PayPal/PromptPay, no Shopify/Woo, no QuickBooks/Xero, no shipping (ShipStation/EasyPost), no tax engine. And **payments are a `payment_method` string** with no gateway — disqualifying for a POS that competes with Toast/Square.
- **Not globally sellable.** VAT 7% hard-coded, THB-only, Thai-first UI with many TH-only strings. This is a Thai product, not a global one — a US/EU buyer can't transact.
- **No native mobile app.** A global POS contender without an iOS/Android app and without offline mode (README/Plan R10 explicitly defers offline) cannot win counter/field/retail deals.
- **No commercial trust artifacts.** No public API docs, no status page/SLA, no support tier, no white-label/theming, no partner/reseller program, no certification track. An auditor or channel partner has nothing to evaluate.

## 3. Concrete upgrades

| Upgrade | Why it matters globally | Tech / approach | Effort | Tier |
|---|---|---|---|---|
| Self-serve signup + tenant provisioning | No-touch acquisition; can't scale GTM without it | Signup flow + email verify (Resend), automated tenant bootstrap, **enforce Postgres RLS** (designed in `docs/03`, not implemented) before opening doors | M | **T0** |
| Subscription billing & metering | The product can't make money otherwise | **Stripe Billing** (plans, trials, proration, dunning) + usage metering via webhooks; tax via **Stripe Tax** | M | **T0** |
| Public versioned API + API keys + webhooks | Table-stakes for any integration or partner; enables marketplace later | `/api/v1/*` with OpenAPI 3.1 (NestJS Swagger), scoped API keys, **outbound webhooks** (signed, retried via existing pg-boss), rate limiting | M | **T0** |
| Payment gateway (POS-grade) | A POS that can't take payment isn't a POS | **Stripe Terminal/Payments + PromptPay/QR** locally; settlement + reconciliation back to AR | L | **T0** |
| Tax + multi-currency + i18n engine | Removes the "Thai-only" ceiling | **Stripe Tax / Avalara / Fonoa**, per-jurisdiction rules, ISO-4217 multi-currency, money as minor-units + ICU/`next-intl` full coverage | L | **T2** |
| Accounting & e-commerce connectors | Buyers expect QuickBooks/Xero + Shopify sync on day one | OAuth connectors (**QuickBooks/Xero**, **Shopify/Woo**), idempotent sync workers on pg-boss; consider Merge.dev/Codat to accelerate | L | **T2** |
| Native mobile + offline POS | Global POS competition is mobile-first and net-flaky | React Native/Expo or Capacitor; **local-first + sync** (CRDT/`ElectricSQL`/PowerSync) to close the R10 offline gap | L | **T1** |
| Developer portal + app marketplace | This is *the* moat vs Odoo/Shopify | Docs site (Mintlify/Docusaurus from OpenAPI), OAuth app registration, install/permission model, revenue share | L | **T3** |
| Commercial trust layer | Channel/enterprise won't engage without it | Public docs, **status page** (Statuspage/Better Stack), SLA + tiered support, white-label theming, reseller/partner program & certification | M | **T1** |

## 4. If you do only ONE thing

**Build the self-serve tenant lifecycle: signup → automated provisioning (with RLS enforced) → Stripe Billing.** Everything else in this section is downstream of it. Right now there is no way for a stranger to become a paying customer without you running `db:seed` and inserting a `tenant_id` by hand — that single fact is what makes this software rather than a SaaS product. Closing it converts the existing, genuinely-capable multi-tenant app into something that can actually be *sold* globally, and it forces the two latent blockers (unenforced RLS from `docs/03`, no payment rail) to the surface where they belong.