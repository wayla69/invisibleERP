# 24 — CRM Usability Depth: From Width to a Marketer's Daily Tool — Design & Roadmap

> **Date:** 2026-07-02 · **Status:** v1.1 — **DELIVERED** (F1 #296, F2 #297, F3 shipped) · **Owner:** ERP / Product (CMO + SVP-IT review)
> **Scope:** Close the three gaps that keep the (deep, GL-grade) loyalty/CRM stack from being **operable by a
> marketer without an engineer**: a visual **segment-builder UI** on the already-safe `saved_segments` API,
> a **scheduled RFM re-profiling** job so segments stop drifting stale, and a **provider go-live readiness**
> panel so a tenant can see mock-vs-real delivery at a glance. Build on, don't duplicate — every phase rides
> an existing, merged spine (docs/19 CRM phases, the A–E parity roadmap, the BI report scheduler).

## 0. Why (the honest audit)

A CMO/SVP-IT depth audit (2026-07-02) of the loyalty/CRM suite concluded:

| Area | Verdict |
|---|---|
| Points→GL (accrual/breakage/close, LYL-03..06), concurrency (FOR UPDATE, single-use, claim-first), RLS + encrypted per-tenant creds, PDPA | 🟢 **Deep & production-grade** — system-of-record quality |
| Closed-loop attribution (send → coupon → till redeem → attributed revenue) | 🟢 Real (`marketing-automation.service.ts`) |
| Channel delivery (LINE push/flex/broadcast, SMS, SMTP, delivery receipts E2) | 🟡 Real code, **mock-by-default**; go-live state invisible per tenant |
| **Segmentation** | 🔴 `saved_segments` is **API-only** — no UI; a marketer cannot build an audience |
| **RFM freshness** | 🔴 `CrmService.refreshProfile` is per-member on-demand; **no scheduled bulk refresh** → segments silently lie as customers lapse |
| Journeys / A-B + holdout | 🔴 Missing (strategic, out of scope here — see §5) |

The three 🔴/🟡 operability gaps above are cheap relative to their ROI because their backends already exist.
This plan closes them as **three sequential doc-synced PRs (F1 → F2 → F3)**, same delivery discipline as
docs/19/23 (one PR per phase; narrative + user manual + UAT + harness in the same PR; merge when green).

## 1. Phase F1 — Segment-builder UI + saved segments as first-class audiences

**Goal:** a marketer creates/edits a rule-based audience visually and *uses* it in a blast or campaign.

- **Web `/loyalty/segments`** (nav under Loyalty, perms `marketing`/`exec`): list saved segments (name, rules
  summary, live member count), create/edit with a **rule-row builder** driven entirely by
  `GET /api/loyalty/saved-segments/catalog` (field → kind-appropriate op list → typed value input; `all/any`
  toggle), **live preview** via `GET /api/loyalty/saved-segments/:id/members` (count + first page), delete.
  No new field/op logic in the web app — the catalog is the single source of truth (server whitelist stays
  the only gate, per rev 1.21's safe-by-construction contract).
- **Wire into send surfaces** (the actual usability payoff):
  - `POST /api/messaging/blast`: new audience `saved_segment` + `saved_segment_id` — resolves via
    `SavedSegmentsService` (tenant-scoped), then the existing per-member consent-respecting send loop.
  - `loyalty_campaigns`: new audience `saved_segment` + `saved_segment_id` column (nullable FK; migration
    next-free `02xx`, additive + RLS n/a on existing table); `resolveAudience` gains the branch. Claim-first
    idempotency, consent skip, and `message_log` audit are untouched (MKT-10 unchanged).
  - Campaigns UI (`/loyalty/campaigns`) + Member-360 blast picker: audience dropdown gains **กลุ่มที่บันทึกไว้**.
- **Controls:** no new control — audiences resolve through the existing whitelisted/bound rule engine
  (rev 1.21) and sends keep MKT-04/05/10 enforcement. SoD unchanged (`marketing`/`exec` config+send).
- **Verify:** harness `crm` +3 (blast over a saved segment targets only matching members; campaign with
  `saved_segment` audience sends + skips opted-out; deleted/foreign segment → 404). Web build + typecheck.
- **Docs:** narrative 19 (step 23 + new rev), user-manual 13 (§13 segments — screen steps), UAT 11 (+1 case).

## 2. Phase F2 — Scheduled RFM re-profiling (`crm_profile_refresh`)

**Goal:** RFM segments/analytics reflect reality without anyone clicking anything.

- New BI report type **`crm_profile_refresh`** in `bi.service.ts` `REPORT_TYPES` + `generateReport` (exact
  pattern of `ar_collections_dunning`/`cdp_export_sync`): each run sweeps the tenant's **active members** in
  batches (id-keyed pages, safety cap) calling the existing `CrmService.refreshProfile(tenantId, memberId)`
  — no new scoring logic; the single reviewed RFM path stays canonical. Summary reports
  `{profiled, segment_changes, took_ms}`; idempotent (recompute is a pure upsert); injected `@Optional()`
  so partial harnesses stay constructible; per-tenant scoping identical to the other scheduled actions.
- Schedule a `daily` subscription (off-peak); failures surface through the standard scheduled-job failure
  alert (**ITGC-OP-04** — already generic over report types).
- Also expose `POST /api/crm/profiles/refresh` (perms `marketing`/`exec`) for an on-demand full refresh
  (same sweep, capped) so a marketer can force-refresh before a big send.
- **Controls:** no new control ID — monitoring freshness under the existing analytics/monitoring rows +
  ITGC-OP-04 job alerting. No GL.
- **Verify:** harness `crm` +2 (a stale profile is re-bucketed by the sweep — seed an old `last_order_at`,
  run, assert segment flips; second run reports 0 changes/idempotent-ish tallies). `bi` harness still green.
- **Docs:** narrative 19 (step 10/analytics + rev), user-manual 13 (§13 note: segments auto-refresh nightly),
  UAT 11 (+1), `docs/ops/` scheduled-jobs note if present.

## 3. Phase F3 — Provider go-live readiness panel (mock-vs-real visibility)

**Goal:** a tenant (and support) can see in one place whether its messaging actually leaves the building.

- Extend `GET /api/messaging/providers` (or a sibling `/api/messaging/providers/health`) to report per
  channel: `resolved_provider` (`tenant` / `env` / `mock` — from the same resolution order as the gateway),
  `last_send_at` + `last_status` + `last_provider` (one indexed query over `message_log`), and
  `callback_token_set` (boolean only — secret never returned, per rev 1.11's write-only contract).
- `/settings/messaging` gains a **สถานะพร้อมใช้งาน** column/badge per channel: 🟢 live (tenant creds) /
  🟡 platform default / ⚪ demo-mode (mock) — plus "last real delivery" timestamp; keep the existing
  **ส่งทดสอบ** button as the verification action. A ⚪ badge with recent `sent` rows is the silent-no-op
  smell this phase exists to surface.
- **Controls:** read-only observability; no new control (supports ITGC-AC provider-config hygiene). No GL,
  no schema (uses existing `message_log` + `tenant_messaging_config`).
- **Verify:** harness `line-crm` +2 (health shows `mock` before creds and `tenant` after `PUT …/providers/line`;
  secret/callbackToken never leaked in the health payload).
- **Docs:** narrative 19 (step 11 + rev), user-manual 13 (§11 go-live checklist), UAT 11 (+1),
  `docs/ops/integration-providers-status.md` §go-live.

## 4. Delivery discipline

- Three PRs, **F1 → F2 → F3**, each: code + harness + narrative/user-manual/UAT revision bumps in one commit
  series; merge only on all-green CI (92 checks); branch restarts from `main` after each merge
  (same loop as the A–E roadmap).
- Migration numbering: take the **next free 4-digit id at PR time** (F1 is the only phase expected to need
  one — the `loyalty_campaigns.saved_segment_id` column); journal it (sequential idx, ascending `when`).
- Nothing in F1–F3 touches GL postings or SoD rules; the RCM xlsx is expected to be untouched (no new
  control IDs) — if review adds one, regenerate via `build_rcm.py` per the standing policy.

## 5. Explicitly out of scope (next horizon, separate plan)

- **Journey/lifecycle orchestration** (multi-step, wait/branch nodes, frequency capping) — the real
  BuzzeBees/Hato differentiator; needs its own design doc (state machine over `loyalty_campaigns` or a new
  `journeys` spine + the automation engine).
- **A/B testing + holdout control groups** on campaigns (proof of lift).
- **Predictive analytics** (LTV, churn model beyond rule-based RFM).

## Revision history

| Ver | Date | Author | Change |
|---|---|---|---|
| 1.1 | 2026-07-02 | Platform | **DELIVERED.** F1 segment-builder UI + saved-segment audiences (#296, narrative rev 1.24), F2 scheduled RFM re-profiling (`crm_profile_refresh`, #297, rev 1.25), F3 provider go-live readiness panel (rev 1.26) — all doc-synced + harness-verified (`crm` 34/34, `line-crm` 26/26, `compliance` 114/114). §5 (journeys, A/B + holdout, predictive) remains the next horizon. |
| 1.0 | 2026-07-02 | Platform | Initial plan: three-phase (F1 segment-builder UI + saved-segment audiences, F2 scheduled RFM re-profiling via the BI scheduler, F3 provider go-live readiness panel) usability-depth roadmap from the CMO/SVP-IT audit; journeys/AB/predictive deferred to §5. |
