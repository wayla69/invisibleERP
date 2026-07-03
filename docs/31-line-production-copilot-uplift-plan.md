# 31 — LINE Channel: Production Go-Live, Copilot Uplift & Digest KPIs — Design & Roadmap

> **Date:** 2026-07-03 · **Status:** v0.2 — LP-1 DELIVERED · LP-2/LP-3 planned · **Owner:** ERP / Product
> **Scope:** The docs/30 LINE Chat Workbench is **fully delivered** (LC-1..LC-5, merged #333–#343).
> This plan takes the channel from "feature-complete in CI" to **production-grade and smarter**, along
> the three follow-up tracks identified at LC-5 close-out: **(LP-1)** a per-tenant production go-live
> pack for the real LINE OA (credentials readiness, webhook self-diagnostics, operator runbook),
> **(LP-2)** an LLM copilot uplift — broader Thai intent coverage on the existing confirm-first spine,
> centrally routed models, scored CI evals, **(LP-3)** a richer, permission-aware daily digest
> (finance/sales/stock KPIs, per-subscriber selection, flex layout).
> **Decision recorded:** same delivery discipline as docs/19/20/23/30 — each phase is an
> independently-shippable, doc-synced PR (migration *if any* + module + permissions/SoD + narrative +
> user-manual + UAT + cutover-harness), merged only on a fully green CI matrix.

---

## 0. Read this first — build on, don't duplicate

Everything below extends surfaces that already exist. **No new chat spine, no new approval logic, no
second LLM seam.**

- **Per-tenant LINE credentials already exist** — `messaging/tenant-messaging.service.ts`
  (`tenant_messaging_config`, AES-256-GCM at rest, WRITE-ONLY reads) with a go-live readiness view
  (`resolved_provider` tenant→env→mock, `callback_token_set`, last `message_log` row). The gateway
  resolver (`gateways.ts` `resolveCreds`) falls back tenant → `LINE_CHANNEL_TOKEN` env → mock.
- **The webhook already fail-closes in production** — `line-webhook.controller.ts` `verify()` rejects
  (`WEBHOOK_UNVERIFIED`) when no Channel Secret is configured in prod, and HMAC-verifies the raw body
  (`BAD_WEBHOOK_SIGNATURE`) when it is. What's missing is *operator visibility*, not enforcement:
  `validate('line')` only requires `token` (secret optional ⇒ silent prod outage), and the readiness
  view can't answer "has LINE ever actually reached this webhook?".
- **The LLM seam and model routing already exist** — `common/llm-client.ts` (single construction
  point, `setLlmClientForTests` for key-less scripted CI evals — the basis of `ai-eval`) and
  `common/ai-models.ts` (`modelFor(task)`, `ANTHROPIC_MODEL` pin, `aiDpaBlocked()` fail-closed DPA
  gate). The LC-5 copilot already calls through both (it borrows task `doc_extract`) — LP-2 gives
  chat its own task key and widens coverage; it does **not** add a provider or bypass the DPA gate.
- **Confirm-first is a control invariant, not a phase feature.** The copilot (or the LLM) only
  *drafts*; execution requires the LC-1 [ยืนยัน] postback and replays the ordinary command path
  (per-command `resolvePermissions` + unchanged workflow SoD; consume-state-before-act replay
  safety). Every LP-2 intent keeps this shape — **chat/AI never gets its own execution path.**
- **The digest job and delivery loop already exist** — `bi/bi.service.ts` `line_daily_digest`
  (report type + scheduler dueness + `{line_user}` recipient delivery via `LineNotifyService`);
  today it counts only pending approvals / open PRs / alerts-24h and sends plain text. LP-3 widens
  the data + formatting; it does **not** add a second scheduler or delivery path.
- **KPI sources to ride, not rebuild** — ledger balances/cash (`ledger.service.ts`), AR aging /
  collections (`finance`/`collections.service.ts`), sales (`pos`/BI report types), low stock
  (`inv_balances` vs reorder points). The digest aggregates; it owns no cycle logic.

## 1. Phases (one PR each, sequential)

### LP-1 — Production go-live pack: LINE OA readiness + webhook diagnostics + runbook ✅ DELIVERED
- **Close the silent-secret gap:** `validate('line')` additionally requires `secret` (Channel
  Secret) whenever `token` is set — a tenant can no longer save prod-broken creds. Readiness view
  gains `webhook_secret_set` (boolean only; secret stays write-only).
- **"Has LINE ever reached us?"** — record inbound webhook receipt per tenant (ride `message_log`
  with a `line_webhook` inbound row or a lightweight `last_webhook_at` on the config row — decide
  at build; **no new table expected**). Readiness view exposes `last_webhook_at` + last verify
  outcome (ok / bad-signature), so the console shows delivery *and* receipt health at a glance.
- **Settings UI (web):** the messaging settings card gains a LINE OA panel — the tenant's exact
  webhook URL to paste into the LINE Developers console
  (`https://<host>/api/line/webhook/<tenantCode>`), configured/verified badges, `last_webhook_at`,
  and a **[ส่งข้อความทดสอบ]** button (pushes a test message to the clicking admin's own linked
  LINE — permission `users`; refuses if the admin isn't linked).
- **Operator runbook** — `docs/ops/line-oa-golive.md`: create the OA + Messaging API channel,
  disable auto-reply/greeting, issue the long-lived channel access token, set the webhook URL &
  verify, paste token+secret into Settings, flip enabled, confirm readiness badges; env-fallback
  (`LINE_CHANNEL_TOKEN`) single-tenant shortcut; PDPA/data-residency note (what LINE sees);
  rotation guidance (re-issue token → paste → old dies).
- No migration expected; no new permissions. **Docs:** PN-08 (ITGC — webhook authentication
  evidence + readiness), manual 11-administration (LINE OA panel), UAT 01 cases (secret now
  required; test push; readiness fields) + matrix. **Harness:** line-crm — save-without-secret
  rejected, readiness shows `webhook_secret_set`/`last_webhook_at` after a verified event, test
  push lands in `message_log`.

### LP-2 — Copilot uplift: chat-scoped model routing, wider Thai intents, scored evals
- **Own task key:** add `AiTask 'chat_copilot'` (CHEAP tier) in `ai-models.ts`; the webhook stops
  borrowing `doc_extract`. `ANTHROPIC_MODEL` pin and `aiDpaBlocked()` behavior unchanged.
- **Wider intent coverage, same confirm-first spine.** The LLM (and parallel deterministic rules,
  so CI never needs a key) may draft, beyond `pr`: **`expense`/`advance`** (LC-2 path) and
  **`leave`** (LC-3 path). Each draft parks the existing `line_chat_states` confirm payload whose
  postback replays the ordinary text command — new intents add *zero* new execution code. Strict
  JSON schema validation on the LLM output (zod); anything malformed falls through to the honest
  "ยังไม่เข้าใจ" refusal. Multi-turn slot-filling (asking back for a missing qty) is **deferred** —
  one-shot draft or refuse, keeping state machine complexity out of scope.
- **Scored evals in CI:** extend the line-crm harness with a `setLlmClientForTests` scripted client
  driving the LLM branch end-to-end — draft accepted → confirm → doc exists; malformed LLM JSON →
  refusal, nothing created; DPA-blocked env → deterministic path only. Add copilot cases to the
  `ai-eval` scored benchmark (intent extraction accuracy on a fixed Thai utterance set).
- **Budget/abuse guard:** copilot LLM calls ride the existing per-user chat rate limit (LC-3); add
  a per-tenant daily LLM-call cap for chat (env `LINE_COPILOT_DAILY_CAP`, default generous, audit
  row on trip) so a chatty OA can't burn the token budget.
- No migration; no new permissions. **Docs:** PN-26 (AI/BI narrative — chat_copilot task + caps),
  PN-02/07/25 one-line notes (AI can draft expense/leave — same confirm-first entry), manuals
  03/05/09, UAT cases (expense-draft confirm, leave-draft confirm, malformed-LLM refusal) + matrix.
  **Harness:** line-crm + ai-eval as above; ts-debt ratchet stays at baseline.

### LP-3 — Digest 2.0: finance/sales/stock KPIs, per-subscriber selection, flex layout
- **KPI catalog (all read-only aggregates, Asia/Bangkok business day):** `pending_approvals`,
  `open_prs`, `alerts_24h` (existing) + `sales_yesterday` (net sales), `cash_position` (cash/bank
  balance), `ar_overdue` (overdue AR total), `low_stock` (items at/under reorder). Each KPI
  declares its **required permission** (e.g. cash/AR ⇒ `fin_report`|`exec`; sales ⇒
  `dashboard`|`exec`; stock ⇒ `stock`|`planner`) — the digest builder computes once per tenant,
  then **filters per recipient** by their effective permissions at send time (revoked perm ⇒ KPI
  silently drops out; permission-at-send, mirroring LC-4's permission-at-subscribe).
- **Per-subscriber selection:** `subscribe digest [kpi,kpi,…]` stores the chosen KPI keys on the
  recipient entry (`report_subscriptions.recipients[].kpis` — jsonb, **no migration**); bare
  `subscribe digest` keeps the default trio. `digest kpis` lists available keys (permission-aware).
- **Flex layout:** the digest becomes a compact flex bubble (title + KPI rows + updated-at), with
  the current text as `altText` fallback. Zero-data honesty: a KPI with no data reads `—`, never a
  fabricated 0 vs missing ambiguity.
- **Docs:** PN-26 rev bump (digest KPI catalog + per-recipient permission filter), manual 09
  (KPI keys + subscribe syntax), UAT (fin KPI hidden from non-`fin_report` subscriber; selection
  respected) + matrix. **Harness:** line-crm — KPI selection round-trip, permission-filtered send
  (two subscribers, different perms, different payloads), flex altText content.

## 2. What the owner must do outside the codebase (LP-1 prerequisite, not a blocker)

Production go-live ultimately needs the real LINE account actions only the business owner can take
(create the OA, issue the token in the LINE Developers console, paste into Settings). LP-1 ships the
runbook + console so that becomes a 15-minute self-service task; LP-2/LP-3 are fully testable in CI
without any key (deterministic paths + scripted LLM client) and simply light up further when
`ANTHROPIC_API_KEY` (+ `AI_DPA_ACKNOWLEDGED` in prod) and the OA creds are configured.

## 3. Sequencing & verification

LP-1 → LP-2 → LP-3, each: `pnpm -r typecheck`, `pnpm --filter @ierp/api build` (+ web build when the
settings panel lands in LP-1), `line-crm` harness extended and green (LP-2 also `ai-eval`), full CI
matrix green before merge. Controls stance: **no new RCM control expected** — LP-1 strengthens
existing ITGC-AC webhook-authentication evidence; LP-2/LP-3 stay inside the documented AI-draft /
digest channel extensions (PN-26). If build reveals a genuine control change, add it to the RCM via
`build_rcm.py` regeneration per policy.

## Revision history

| Version | Date | Change |
| --- | --- | --- |
| v0.1 | 2026-07-03 | Initial plan — LP-1 go-live pack, LP-2 copilot uplift, LP-3 digest 2.0 (follow-ups from docs/30 close-out). |
| v0.2 | 2026-07-03 | LP-1 delivered as planned (no migration): required Channel Secret, `line_webhook` receipt-health row + readiness fields (`webhook_secret_set`/`webhook_path`/`last_webhook_at`/`last_webhook_status`), settings go-live panel + `POST /api/messaging/providers/line/test-self`, runbook `docs/ops/line-oa-golive.md`; `line-crm` 91 ✓ (every harness webhook delivery now HMAC-signed). |
