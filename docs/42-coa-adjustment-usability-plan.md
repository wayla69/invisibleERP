# docs/42 — CoA adjustment & mapping usability (DELIVERED)

**Status: DELIVERED (all 4 steps, one PR series).**
Question answered: *"ถ้าเรามีการปรับเพิ่ม/ลดผังบัญชี (CoA) ต้องผูกบัญชีตรงไหนบ้าง และทำให้ง่ายต่อการใช้จริงได้อย่างไร"*

## 0. The impact map (what a CoA change touches)

Two account universes govern everything:

| Layer | Table | Scope | Who may change it |
|---|---|---|---|
| Canonical universe | `accounts` (no `tenant_id`) | shared by EVERY tenant; the posting engine hard-references its codes | platform Admin/HQ only (`COA_ADMIN_ONLY`, GL-11) |
| Per-tenant overlay | `tenant_accounts` (RLS) | presentation only — which codes are active on MY chart, names/grouping | any `gl_coa` holder (GL-11) |

Adding/removing a **canonical** account additionally touches, in code:

1. `ledger-constants.ts` — the `COA` seed array + `CF_CLASSIFY` cash-flow bucket (+ `CASH_ACCOUNTS` if a cash account).
2. `finance-metrics-constants.ts` — current/non-current KPI classification.
3. `ledger-cashflow.service.ts cashContraCategory()` — direct-method SCF map (cash-adjacent accounts only).
4. `coa-templates.ts` — the industry templates that should surface the account (boot-asserted subset of `COA`).
5. Consuming services' posting sites (literal or determination default).
6. A journaled migration INSERT for live DBs (the seed constant only covers fresh boots).

Removal is **never a DELETE**: retire via `POST /api/ledger/accounts/:code/deactivate`
(`ACCOUNT_HAS_BALANCE` guard; history intact; `isPostable=false` blocks new activity).

## 1. Step 1 — fail-closed account-universe guard in `postEntry` (GL-21 extension)

The gap: `postEntry` never validated `account_code` existence/postability — a posting to an
unknown/retired code landed silently and then **vanished from every typed report** (they INNER JOIN
`accounts`). Now every line of every posting (any source; `viaSubledger` only relaxes the
control-account rule) must reference a real, postable account or the posting fails
`INVALID_POSTING_ACCOUNT`. `LedgerService` seeds the canonical chart at module init (best-effort,
idempotent) so every embedding — prod bootstrap and all injected harnesses — carries the universe the
guard validates against. ToE: `cutover/compliance.ts` (ghost-account JE → 400) + unit tests
(`ledger-posting.test.ts`).

## 2. Step 2 — /chart-of-accounts becomes the manage surface (GL-11)

The page (previously read-only) now drives the GL-11 write surfaces its API already served:
canonical **create / edit / deactivate** dialogs (platform Admin only; server re-asserts
`COA_ADMIN_ONLY`) and a per-tenant **show/hide overlay toggle** for `gl_coa` holders — gated to
tenants that already run a curated overlay, because the FIRST overlay row flips
`listAccounts` into overlay mode and would collapse the chart to that one row. `CoaController`
canonical bodies are Zod-validated (4-digit code, typed account type).

## 3. Step 3 — posting_determination master switch where it's configured

The docs/33 determination spine (item → category → warehouse → literal, GL-21) is gated by the
per-tenant `posting_determination` flag, which had no UI. `/setup/item-categories` now carries a
status card + toggle (md_config/exec — mirrors `PUT /api/feature-flags/:key`), so "why doesn't my
category account apply?" answers itself on the screen where the accounts are configured.

## 4. Step 4 — tenant posting-rule overrides feed the recurring system posters

The posting-rules engine (migration 0158; `/setup/posting-rules` UI) stored tenant overrides nothing
consumed. `LedgerService.postingOverrides(eventType, tenantId)` returns a tenant's ACTIVE
`posting_rules` rows as a role→account map, consumed as `override ?? literal` by:

| Poster | Events / roles |
|---|---|
| Payroll run | `PAYROLL.GROSS` wages_expense · `PAYROLL.SSO` sso_expense/sso_payable · `PAYROLL.WHT` wht_payable · `PAYROLL.PF` pf_expense/pf_payable |
| FA depreciation run | `DEPRECIATION.FA` dep_expense/accum_dep |
| Lease periodic run | `LEASE.INTEREST` interest_exp · `LEASE.PRINCIPAL` lease_liab/cash · `DEPRECIATION.ROU` dep_expense/accum_dep_rou |

Design rails: only TENANT-scoped rows apply — the NULL-tenant rows seeded by 0158 are display
defaults that pre-date the real posting paths (some drift from the literals) and must never shadow
the code; an un-configured tenant posts **byte-identically** (golden master unchanged); a typo'd
override fails closed at step 1's account guard. ToE: `cutover/payroll.ts` (tenant
`PAYROLL.GROSS`→5601 re-map lands end-to-end).

## Residual roadmap (not in this series)

- Extend `postingOverrides` to the remaining literal posters (projects, POS/restaurant, petty-cash,
  inventory constants) — same `override ?? literal` pattern, one module per PR.
- New event types (asset acquisition/disposal, lease commencement) need a seeded
  `posting_event_types` migration before they can be overridden.
- `accounts` as a masterdata bulk-IO entity (HQ import of the canonical chart) — deliberately
  deferred: canonical writes are rare and controlled (GL-11).

## Revision history

| Date | Version | Change |
|---|---|---|
| 2026-07-11 | 1.0 | Initial plan + delivery (steps 1–4) in one PR series. |
