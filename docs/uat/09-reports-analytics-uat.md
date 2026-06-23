# UAT — Cycle 09: Reports & Analytics

**Status: DRAFT v0.1 · 2026-06-22** · Cross-ref: process narratives `01-order-to-cash.md`, `04-general-ledger-close.md`; harness `tools/cutover/src/e2e.ts`, `worldclass.ts`. Endpoints under `/api/reports`, `/api/analytics`, `/api/bi`, `/api/finance`, `/api/dashboard`.

Result legend: Pass / Fail / Blocked / N/A / Not Run. Amounts are exact (seed: today's sales = 107, low-stock items = 2).

| Test ID | Scenario/Title | Role | Preconditions | Test steps | Test data | Expected result | Priority | Type | Traceability | Result | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|
| UAT-RPT-001 | Dashboard summary KPIs | ExecutiveViewer/Admin | Seed sale 107, 2 low-stock | 1. `GET /api/dashboard`. | — | 200; `today.sales`=107; `low_stock_count`=2. | High | Positive | RPT | Not Run | e2e.ts |
| UAT-RPT-002 | Finance KPI MTD revenue | FinancialController | Seed sale 107 | 1. `GET /api/finance/kpi`. | — | `mtd_revenue`=107. | High | Positive | RPT | Not Run | e2e.ts |
| UAT-RPT-003 | Stock summary report | InventoryController | 3 items seeded | 1. `GET /api/inventory/stock?limit=50`. | — | `total`=3; `low_stock_count`=2. | Med | Positive | RPT | Not Run | e2e.ts |
| UAT-RPT-004 | Notifications counts | Admin | 2 low-stock items | 1. `GET /api/notifications`. | — | `counts.low_stock`=2. | Med | Positive | RPT | Not Run | e2e.ts |
| UAT-RPT-005 | Replenishment analytics | Planner | Items with reorder points | 1. `GET /api/analytics/replenishment`. | — | 200; replenishment suggestions returned. | Med | Positive | RPT | Not Run | e2e.ts |
| UAT-RPT-006 | AR aging report | ArClerk | AR invoices exist | 1. `GET /api/finance/ar/aging`. | — | 200; aging buckets reconcile to AR sub-ledger total. | High | Detective | REC-01 | Not Run | finance |
| UAT-RPT-007 | AP aging report | ApClerk | AP transactions exist | 1. `GET /api/finance/ap/aging`. | — | 200; aging buckets reconcile to AP sub-ledger total. | High | Detective | REC-01 | Not Run | finance |
| UAT-RPT-008 | P&L / income statement | FinancialController | Postings exist | 1. `GET /api/finance/pl` (or `/api/ledger/income-statement`). | `<<period>>` | 200; revenue−expense = net income; ties to trial balance. | High | Detective | GL-06 | Not Run | worldclass.ts |
| UAT-RPT-009 | Daily sales report + export | Sales/Admin | Sales exist | 1. `GET /api/reports/daily-sales`. 2. `GET /api/reports/daily-sales/export`. | `<<date range>>` | 200; export downloads (CSV/file) with matching totals. | Med | Positive | RPT | Not Run | reports |
| UAT-RPT-010 | Monthly P&L export | FinancialController | — | 1. `GET /api/reports/monthly-pl/export`. | `<<month>>` | 200; file downloads. | Med | Positive | RPT | Not Run | reports |
| UAT-RPT-011 | Stock summary export | InventoryController | — | 1. `GET /api/reports/stock-summary/export`. | — | 200; file downloads with all items. | Low | Positive | RPT | Not Run | reports |
| UAT-RPT-012 | AP aging export | ApClerk | — | 1. `GET /api/reports/ap-aging/export`. | — | 200; file downloads. | Low | Positive | RPT | Not Run | reports |
| UAT-RPT-013 | Sales-cube / trend (BI) | ExecutiveViewer | Sales data | 1. `GET /api/analytics/sales-cube`. 2. `GET /api/analytics/sales-trend`. | — | 200; aggregated dimensions/series returned. | Med | Positive | RPT | Not Run | analytics |
| UAT-RPT-014 | Anomaly detection | Admin | Activity data | 1. `GET /api/analytics/anomalies`. | — | 200; anomalies list (may be empty) returned. | Low | Detective | RPT | Not Run | analytics |
| UAT-RPT-015 | Reconciliation dashboard | FinancialController | AR/AP activity | 1. `GET /api/finance/reconciliation`. | — | `ar.reconciled: true`; AP balanced. | High | Detective | REC-01 | Not Run | worldclass.ts |
| UAT-RPT-016 | RLS — reports scoped to own tenant | Sales (T2) | T1 + T2 sales | 1. `GET /api/dashboard` as T2 user. | bearer T2 | Only T2 figures; no T1 sales co-mingled. | High | Control | ITGC-AC (RLS) | Not Run | worldclass.ts |
| UAT-RPT-017 | Permission — viewer cannot mutate | ExecutiveViewer | read-only role | 1. Attempt a write (e.g. `POST /api/ledger/journal`). | — | 403 Forbidden (read-only). | Med | Control | ITGC-AC-07 | Not Run | — |
| UAT-RPT-018 | RAG ingest + retrieve a policy (D2) | masterdata/ai_chat | — | 1. `POST /api/ai/kb/documents` (refund policy). 2. `GET /api/ai/kb/search?q=refund within 14 days`. | policy text | Doc chunked; top hit is the policy with score > 0.15. | High | Positive | Feature (RAG) | Not Run | rag.ts |
| UAT-RPT-019 | RAG cite-or-refuse — off-topic refused | ai_chat | Policy ingested | 1. `GET /api/ai/kb/ask?q=<unrelated question>`. | — | `refused: true`, no citations (no hallucinated answer). | High | Control | Feature (RAG safety) | Not Run | rag.ts |
| UAT-RPT-020 | RAG tenant isolation (RLS) | ai_chat (T2) | T1 has KB docs | 1. `GET /api/ai/kb/search`/`ask` as T2. | bearer T2 | 0 results; ask refuses — no T1 leakage. | High | Control | ITGC-AC-03 | Not Run | rag.ts |
