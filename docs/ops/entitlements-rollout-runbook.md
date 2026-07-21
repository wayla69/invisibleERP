# Entitlements Enforcement Rollout — ENTITLEMENTS_SHADOW → ENTITLEMENTS_ENFORCE

> **Status:** v1.0 · **Date:** 2026-07-21 · **Owner:** Platform / Ops (commercial decisions: CEO/CFO)
> Procedure for taking production plan-entitlement gating (docs/36 §5, docs/53 packaging) from
> default-off → shadow observation → enforced, with per-tenant remediation and instant rollback.
> Cross-refs: [`../36-monetization-packaging.md`](../36-monetization-packaging.md) §5,
> [`deployment.md`](deployment.md), [`observability-incident.md`](observability-incident.md),
> [`change-management.md`](change-management.md), [`../53-pricing-packaging-overhaul.md`](../53-pricing-packaging-overhaul.md).

## 1. What flipping enforcement actually changes

With both flags off (today's default) the API runs **legacy** behaviour: only `@RequiresPlanFeature`
routes (e.g. `ai_chat`) are gated, and a per-tenant `Admin` bypasses even that. Under
`ENTITLEMENTS_ENFORCE=true` the `PlanGuard` gates **every** `@Permissions` route against the tenant's
entitled suites AND activates subscription-status blocking. This is more than the suite fences:

| 403 code | Fires when | Notes |
|---|---|---|
| `SUITE_NOT_ENTITLED` | none of the route's module tokens is in the plan's suites (or an `@RequiresSuite` premium suite is missing) | the docs/53 commercial fences |
| `TRIAL_EXPIRED` | status `Trialing` and `trial_ends_at` in the past | the **trial backlog fires immediately at flip** |
| `SUBSCRIPTION_INACTIVE` | status `Canceled`, or `PastDue` beyond the grace window | |
| `SUBSCRIPTION_PASTDUE_READONLY` | status `PastDue` within grace (`BILLING_GRACE_DAYS`, default 7) on a write; reads still pass | grace applies to `GET/HEAD/OPTIONS` only |
| `PLAN_FEATURE_REQUIRED` | `@RequiresPlanFeature` flag absent from `plans.features` | now WITHOUT the per-tenant-Admin bypass |

Other semantics to know before the flip:
- **Bypass:** only the platform owner (`PLATFORM_ADMIN_USERNAMES`) and server-set `__platformBypass`
  requests bypass. **A per-tenant Admin no longer bypasses anything** (the 1.2 fix).
- **Fail-open on infra error** (a DB blip never locks a tenant out); **fail-closed to `core`** when a
  subscription row is missing or the plan code is unknown.
- Suites resolve as: plan row `features.suites` (DB override) → `PLAN_SUITES` code default →
  `core`-only; purchased `subscriptions.addons` union in (`resolveEntitledSuites`).
- `Trialing` within its window is granted **all** suites (trial = full product).

## 2. Observability — the two log lines

Every shadow/enforce decision emits TWO lines to the api service stdout (Railway log stream):

1. Legacy console line (plain text, `Logger('PlanGuard')`):
   `[shadow] WOULD block <CODE> tenant=<id> route-perms=[...]` (shadow) /
   `entitlement block <CODE> tenant=<id> route-perms=[...]` (enforce).
2. **Structured pino JSON** (added for this rollout; ToE `cutover:plan-gating`):
   `{"event":"entitlement_shadow_block"|"entitlement_block","tenant_id":…,"code":"…",
   "tokens":[…],"plan_code":"…","sub_status":"…","method":"…","url":"…","username":"…"}`
   — self-contained for triage (no tenant→plan join needed). Deliberately **not** `alert:"ops"`:
   shadow denials are expected traffic and must never page.

Only would-block requests log — volume ≈ the number of requests enforcement would deny, not traffic.

## 3. Preconditions checklist (all must pass before Stage 1)

Run against production (god session / Railway psql). Tick each:

- [ ] **Deploy level:** api image includes the docs/53 packaging + the structured telemetry
      (`plan.guard.ts` emits `entitlement_shadow_block`) + 0454/0455 migrations applied
      (`SELECT tag FROM drizzle.__drizzle_migrations ORDER BY id DESC LIMIT 3` or check the boot log).
- [ ] **Plan rows carry suites (the 1.3 backfill):** boot `seedPlans()` does this automatically —
      verify: `curl -s $API/api/billing/plans | jq '.plans[] | {code, suites: .features.suites|length}'`
      → every row ≥ 1. (docs/36 §5: do NOT enforce before this shows suites on every plan.)
- [ ] **Grandfathering snapshots populated:**
      `SELECT count(*) FROM subscriptions s JOIN plans p ON p.code=s.plan_code
       WHERE s.grandfathered_price IS NULL AND p.price_monthly::numeric > 0;` → expect **0**.
- [ ] **God bypass alive:** `PLATFORM_ADMIN_USERNAMES` set on the api service (else nobody bypasses).
- [ ] **Grace window intentional:** `BILLING_GRACE_DAYS` (unset = 7) agreed with Finance.
- [ ] **Status backlog snapshot (the biggest real impact):**
      ```sql
      SELECT status, count(*) FROM subscriptions GROUP BY 1;
      SELECT count(*) AS expired_trials FROM subscriptions
        WHERE status='Trialing' AND trial_ends_at < now();
      SELECT count(*) AS pastdue_beyond_grace FROM subscriptions
        WHERE status='PastDue' AND current_period_end < now() - interval '7 days';
      ```
      Every row in the last two counts is **blocked at flip**. Do not proceed unless the A2
      `saas_lifecycle` scheduler has been running long enough that these tenants have received
      their trial-expiry/dunning emails (`GET /api/admin/saas-lifecycle/events`).

## 4. Stage 1 — enable SHADOW

1. Railway → **api** service → Variables: set `ENTITLEMENTS_SHADOW=true` (leave
   `ENTITLEMENTS_ENFORCE` unset/false). Redeploy/restart the api service.
2. **Probe** (proves the wiring, same day): using any *expired-trial* tenant account (or a
   throwaway Trial company created then date-shifted), call a non-portal route; confirm the request
   still succeeds AND both §2 log lines appear in the Railway stream.
3. **Observation window:** minimum **7 days AND spanning one month-end close** (finance-heavy
   routes concentrate there). Shadow adds one subscription read per gated request — no user impact.

## 5. Triage — turning shadow logs into a remediation list

Export the window's api logs (Railway CLI: `railway logs -s api > shadow.log`, or the dashboard
export) and aggregate:

```bash
grep '"event":"entitlement_shadow_block"' shadow.log \
  | jq -r '[.tenant_id, .plan_code, .code, (.tokens|join("+"))] | @tsv' \
  | sort | uniq -c | sort -rn
```

Classify every distinct (tenant, code, tokens) row:

| Finding | Meaning | Action | Lever |
|---|---|---|---|
| `TRIAL_EXPIRED` | trial backlog | commercial exception? extend trial; else let A2 suspend | `POST /api/admin/tenants/:id/extend-trial` |
| `SUBSCRIPTION_INACTIVE` / `_PASTDUE_READONLY` | dunning backlog | verify A2 already emailed; collections decision | A2 lifecycle / Stripe |
| `SUITE_NOT_ENTITLED`, tokens map to `scm_advanced`/`integrations`/`cdp`/`sandbox` | tenant uses an add-on surface | sell/comp the add-on | `POST /api/admin/tenants/:id/addons` — **replaces the whole set; read current `addons` first** |
| `SUITE_NOT_ENTITLED`, any base suite (finance/pos_frontoffice/planning/…) | tenant genuinely uses a suite outside its plan | plan change (customer conversation) — **warn: `changePlan` re-snapshots the 0454 grandfathered price at the NEW plan's current list** | `POST /api/admin/tenants/:id/plan` |
| bespoke enterprise deal that fits no plan | last resort | **new custom `plans` row** (SQL insert with tailored `features.suites` + price) then `changePlan` to it — change-management sign-off required (`change-management.md`); **never edit a shared plan row** (`features.suites` on a plan re-gates every tenant on that plan) | SQL + changePlan |

There is **no per-tenant suite override** — the levers above are the complete set. The flip gate:
this table is empty, or every remaining row has a named owner decision ("let it block").

## 6. Stage 2 — enable ENFORCE

1. Send the §8 notice to every tenant on the remediation list at least 3 business days ahead.
2. Railway → api service: set `ENTITLEMENTS_ENFORCE=true`, set `ENTITLEMENTS_SHADOW=false`.
   Redeploy during low traffic (recommended: 05:00–06:00 Asia/Bangkok; avoid 25th–5th close window).
3. **Post-flip verification (within 30 min):**
   - [ ] god account operates normally across companies (bypass intact);
   - [ ] a healthy paid tenant's normal flows green (login, POS sale or order, billing page);
   - [ ] an expired-trial tenant now receives `403 TRIAL_EXPIRED` (expected!);
   - [ ] public `GET /api/billing/plans` and the `/plans` page still 200 (public routes unaffected);
   - [ ] Railway stream: `entitlement_block` lines match the triage expectations — no NEW
         (tenant, tokens) pairs that the shadow window never showed.
4. **Watch (48 h):** api error rate, `"event":"entitlement_block"` aggregation re-run twice daily,
   support channel. A paying tenant blocked on a base suite = severity-2 → remediate with §5 levers
   (addon/plan change take effect immediately, no restart) or roll back.

## 7. Rollback

Set `ENTITLEMENTS_ENFORCE=false` (optionally `ENTITLEMENTS_SHADOW=true` to keep observing) on the
api service and redeploy — config-only, takes effect at boot, no data to unwind (denials are
stateless 403s; nothing was written). Legacy behaviour returns byte-for-byte.

## 8. Tenant notice template (send before the flip)

> **TH:** เรียนลูกค้า [company] — ตั้งแต่วันที่ [date] ระบบจะบังคับสิทธิ์การใช้งานตามแพ็กเกจจริง
> ([plan]) จากการตรวจสอบ พบว่าบัญชีของท่านมีการใช้งานโมดูล [module] ซึ่งไม่อยู่ในแพ็กเกจปัจจุบัน
> กรุณาเลือก: (1) อัปเกรดเป็นแพ็กเกจ [target] (ราคาปัจจุบัน ฿[price]/เดือน) หรือ (2) เพิ่มโมดูลเสริม
> [addon] (฿[addon price]/เดือน) ภายใน [date] มิฉะนั้นการเข้าถึงโมดูลดังกล่าวจะถูกระงับ —
> ทีมงานยินดีช่วยเหลือที่ [contact]
>
> **EN:** Dear [company] — from [date] the platform will enforce module access according to your
> subscribed plan ([plan]). Our review shows your account uses [module], which is outside your
> current plan. Please either (1) upgrade to [target] (current price ฿[price]/mo) or (2) add the
> [addon] add-on (฿[addon price]/mo) by [date]; otherwise access to that module will be suspended.
> We are happy to assist at [contact].

## Revision history

| Version | Date | Author | Notes |
|---|---|---|---|
| 1.0 | 2026-07-21 | Platform / Ops | Initial runbook (post-docs/53 packaging; structured `entitlement_shadow_block`/`entitlement_block` telemetry added to `plan.guard.ts` with ToE in `cutover:plan-gating`). |
