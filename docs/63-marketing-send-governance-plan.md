# docs/63 — Marketing send-governance completeness + the A/B winner-adoption loop

**Status: Phase 1 DELIVERED** · Owner: Platform · Builds on docs/27 (W3 messaging governance), docs/61
(activation MKT-21..25), docs/62 (autopilot + statistical honesty).

## Why

The docs/61 activation suite (Studio, NBA, churn-save, segment×channel) all ultimately produce **consent-gated
broadcast campaigns** (`loyalty_campaigns`) that a human sends. docs/27 W3 added tenant-wide messaging
governance — quiet hours + a **global cross-channel weekly cap** (`weekly_cap` marketing messages / member /
7 days, counted over ALL sent marketing rows in `message_log`) — enforced inside `MessagingService.send`.
Journeys, blasts, automation actions and ad-hoc sends route through `send`, so they obey it. **Campaigns do
not** — `CampaignsService.sendCampaign` sends through its own claim-first, at-most-once `deliver` path
straight to the gateway. So a campaign send *counted toward* the cap's denominator but never *enforced* it: a
member already maxed out by journeys/blasts still received campaigns. That is a real contact-pressure /
PDPA-adjacent hole precisely on the activation suite's send path.

(Recon note — verify-the-premise, CLAUDE.md #15: the contact-frequency governance itself is NOT missing; it
was built in docs/27 W3. The gap is the campaigns engine bypassing it.)

## Phase 1 — Close the campaigns governance bypass — **DELIVERED**

**Goal.** A broadcast campaign honours the same global cross-channel cap as every other marketing engine.

**Delivered (no new control, no migration, census unchanged — rides MKT-04/12).**
- Extracted `countRecentMarketingSends(db, memberId, tenantId, since)` in `messaging.service.ts` (the cap
  denominator: sent marketing rows in `message_log`, any channel/engine) and refactored `MessagingService.send`
  to use it — byte-identical, Boy-Scout DRY.
- `CampaignsService.sendCampaign` resolves the tenant governance once (`TenantMessagingService.getGovernance`);
  `deliver` applies the cap in the same order `send` does — **consent → cap → send** — auditing an at-cap
  member `skipped: 'global cap'` (never contacted). `CampaignsModule` imports `MessagingModule` for
  `TenantMessagingService` (`@Optional`; one-directional, cycle-free).
- **Scope decision:** quiet-hours deferral is deliberately NOT extended to campaigns. A campaign is a one-shot
  claim-first broadcast with no per-member re-arm (unlike a journey step); a quiet-window drop would silently
  void an entire scheduled send. The verified cross-channel gap was the *frequency* cap — now closed. (A
  future option: a scheduled-campaign quiet-hours *reschedule* rather than a drop.)
- **Opt-in / zero-regression:** a tenant with no governance row has `weekly_cap = 0`, so the new branch never
  runs — every campaign harness stays byte-identical (compliance LYL-12 3/2/1, crm segment 2/1/1).
- **ToE:** `line-crm` W3 section +1 (144) — with a member already at `weekly_cap = 1`, a tier-targeted
  campaign send skips them `global cap` (`targeted=1 sent=0 skipped=1`).

## Phase 2 — A/B winner-adoption loop (NOT STARTED)

The docs/62 Phase 3 Studio A/B *measures* per-variant outcome (`GET /studio/ab/:campaignId`) but nothing
feeds the winner back. Phase 2 would surface/adopt the winning creative variant for the next send (e.g. an
advisory "variant B won by +X% [CI] — promote to primary?" on the model card, honouring the weak-evidence
flag so a weak winner is not auto-promoted). Read-first, adoption stays a human decision. Its own PR.

## Non-goals

No new contact channel or send path; no auto-send/auto-spend; no new table or control ID (Phase 1 rides the
existing W3/MKT-04/12 governance).

## Revision history

| Rev | Date | Notes |
|---|---|---|
| v0.1 | 2026-07-24 | **Phase 1 DELIVERED — broadcast campaigns honour the W3 global cross-channel marketing cap.** Extracted `countRecentMarketingSends` (shared by `MessagingService.send` + campaigns); `CampaignsService.deliver` enforces the cap (consent → cap → send, audited `global cap`); `CampaignsModule` imports `MessagingModule` (cycle-free). Quiet-hours intentionally not extended to one-shot campaigns. No control/migration/census change. PN-19 §7 step 32 + §9 row 32 + rev 1.76; ToE `line-crm` +1 (144); campaign harnesses byte-identical. |
