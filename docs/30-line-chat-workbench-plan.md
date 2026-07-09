# 30 — LINE Chat Workbench: Rich Interactions, Money Self-Service & Governance — Design & Roadmap

> **Date:** 2026-07-03 · **Status:** v1.0 — **DELIVERED (LC-1..LC-5 all shipped & merged)** · **Owner:** ERP / Product
> **Scope:** Take the delivered LINE staff-chat channel (0227 `link`/`pr`/`status` → PR, merged #333;
> 0228 workflow notifications + `approve`/`reject` + `my prs`/`find`/`cancel`/`stock`, merged #335)
> from a *text command line* to a **chat workbench**: one-tap rich interactions (flex cards + postback
> buttons), the first **money self-service** cycle beyond procurement (petty-cash/expense, EXP-07/08),
> and the **governance layer** an auditable chat channel needs (admin link registry, rate limiting).
> **Decision recorded:** Same delivery discipline as `docs/19`/`20`/`23` — each phase is an
> independently-shippable, doc-synced PR (migration *if any* + module + permissions/SoD + narrative +
> user-manual + UAT + cutover-harness), merged only on a fully green CI matrix.

---

## 0. Read this first — build on, don't duplicate

The chat spine is **already built**; this plan adds no new business-cycle accounting — it deepens the
channel over flows the modules already own:

- **Webhook + identity** — `apps/api/src/modules/messaging/line-webhook.controller.ts`:
  signature-verified per-tenant webhook, linear token command router,
  LINE message-id dedupe (`message_log.provider_ref`), reply via `replyLine`. *(2026-07-09
  decomposition, zero behaviour change: staff identity binding — `users.line_user_id`, one-time code,
  migration `0227` — plus the per-command `resolvePermissions` re-check now live in
  `messaging/line-link.service.ts`; copilot draft parsing in `line-copilot.service.ts`; the flex
  cards/usage text in `line-cards.ts`.)*
- **Staff notifications** — `messaging/line-notify.service.ts` (`notifyUser`/`notifyRole`, campaign
  `wf_notify`) hooked into `WorkflowService.start`/`act` (queue entry + final decision). Best-effort by
  design — a failed push never blocks an approval.
- **Rich-message plumbing already exists** — `messaging/gateways.ts`: `flexMessage()`,
  `pushLineFlex()`, `broadcastLineFlex()`; only a *reply*-flavored flex helper and a postback handler
  are missing.
- **Money flows to ride, not rebuild** — petty-cash funds/expenses/advances with maker-checker
  (**EXP-07/EXP-08**, `modules/finance/finance.service.ts`, GOV-01 pending queue); ESS/HCM leave &
  timesheets (`modules/ess`, `modules/hcm`, PN-25).
- **Controls precedent** — chat is documented as a *channel extension* of EXP-03/R07 (PN-02 §3/§7/§9,
  rev 1.6–1.7): identity chain + per-command permission re-check + the unchanged engine enforcing
  maker-checker. Every phase below keeps that shape: **chat never gets its own approval logic.**

## 1. Phases (one PR each, sequential)

### LC-1 — Rich interactions: flex cards + one-tap postback approve ✅ DELIVERED
- **Queue-entry notification becomes a flex bubble** (altText keeps the current text for
  notification previews): PR number, requester, line summary, and buttons
  **[อนุมัติ] [ปฏิเสธ] [ดูรายละเอียด]** using LINE *postback* actions.
- **Webhook gains `ev.type === 'postback'`**: postback `data` carries `{action, docNo, nonce}`.
  The handler resolves the SAME staff identity, re-checks `procurement`, and calls the SAME
  `approvePr` path as the text command — one-tap is a UX change, not a control change. A short
  **confirm step** (reply with [ยืนยัน] postback) guards fat-finger approvals; nonce + LINE
  webhook-event dedupe block replays.
- `my prs` upgrades to a compact carousel (falls back to text when >10 rows).
- New gateway helper `replyLineFlex`; no migration; no new permissions.
- **Docs:** PN-02 §7 step 3 note (postback = same engine path), manual 03 (buttons), UAT +2 cases
  (postback approve happy + replayed postback ignored). **Harness:** line-crm — postback approve,
  confirm flow, replay negative, carousel altText.

### LC-2 — Petty-cash & expense self-service (EXP-07/08 channel extension) ✅ DELIVERED
- **`expense <fund> <amount> <เหตุผล/doc-ref>`** raises a petty-cash **expense request** (PEX-,
  maker only) via the existing `finance` petty-cash service — Pending, **no GL**, exactly like the
  web. `advance <fund> <amount> <เหตุผล>` mirrors the advance request. Settlement stays web-only
  (needs receipts/attachments).
- **Approval-queue notifications extend to petty-cash**: linked approvers get the 🔔 when a PEX-/ADV-
  lands (GOV-01 pending surface); requester gets ✅/❌ on decision. Chat approval of *money*
  requests is **deliberately deferred** — phase LC-2 keeps chat as a *raise + notify* channel for
  EXP-07/08 (decision only via `/petty-cash`), pending a controls review; revisit in LC-3 retro.
- Permission: `creditors` (the same perm the web maker uses), re-resolved per command. No migration
  (rides existing tables).
- **Docs:** PN-07 (cash/treasury, EXP-07/08 sections) + manual 05-finance + UAT 03/07 cases +
  matrix. **Harness:** line-crm — expense raise happy, over-float negative (`INSUFFICIENT_FLOAT`),
  no-`creditors` negative, approver notification.

### LC-3 — ESS leave + channel governance (ITGC-AC) ✅ DELIVERED
- **`leave <from YYYY-MM-DD> <days> <เหตุผล>`** raises an ESS leave request through the existing
  HCM/ESS flow (verify the exact service entry point before build; PN-25). Approver notification +
  decision push reuse `LineNotifyService`.
- **Admin link registry** — `GET /api/line/links` (perm `users`, AccessAdmin): who is linked, when
  bound, last chat activity; admin **force-unlink** (`DELETE /api/line/links/:username`) for
  offboarding — closes the ITGC-AC gap where a departed employee's LINE stays bound (today only
  `is_active=false` blocks them; force-unlink makes the evidence clean).
- **Rate limiting** — per-LINE-user command budget (e.g. 30 commands / 5 min, in-memory + logged
  drop) so a compromised or scripted account can't hammer the webhook; audit row on throttle.
- **Docs:** PN-08 (ITGC) link-registry note + PN-25 leave section + manual 11-administration +
  UAT 01/07 cases + matrix. **Harness:** line-crm — leave raise, force-unlink kills the channel,
  rate-limit negative.

### LC-4 — Ops & insights push: alert / report subscriptions in chat ✅ DELIVERED
- **`subscribe` / `unsubscribe` commands** bind the linked staff user's LINE as a delivery target for
  surfaces the platform already produces: threshold **alerts** (`modules/alerts` already supports a
  `line` channel with an explicit `target_to` — this phase resolves the target from the *linked
  identity* instead of a hand-typed id), and **scheduled BI reports** (`modules/bi` report
  subscriptions — add `line` beside the existing email delivery: the run pushes a compact summary +
  a link to the full report, never the raw dataset in chat).
- **Daily digest** — one opt-in morning push per user (business TZ) bundling: their pending
  approvals, their PRs that moved, and any subscribed alert breaches since yesterday. Reuses
  `LineNotifyService`; scheduled via the existing BI scheduler (`REPORT_TYPES` "action" job pattern —
  idempotent per user+day).
- Permission: subscriptions are self-service for the *linked user's own* targets only; report
  subscriptions still require the report's own permission at subscribe time (no data-permission
  bypass via chat). Likely no migration (alert targets + report subscriptions are existing tables;
  digest opt-in can ride `user_prefs`).
- **Docs:** PN-26 (reporting/BI) delivery-channel note + manual 09-reports + UAT 09 cases + matrix.
  **Harness:** line-crm — subscribe→alert breach pushes to linked LINE, unsubscribe stops it,
  digest idempotency (one push per day), permission-at-subscribe negative.

### LC-5 — Thai natural-language copilot in chat (confirm-first) ✅ DELIVERED
- **Free-text understanding**: a linked user types natural Thai ("ขอกระดาษ A4 สัก 10 รีม ด่วน ๆ
  พรุ่งนี้ใช้") and the bot drafts the structured command via the existing AI layer
  (`modules/ai/agent.service.ts` + `ai-action.service.ts` intent/action pattern — reuse its action
  schema, don't build a second parser). The draft is **always echoed back as a confirm card**
  ([ยืนยันสร้าง PR] postback from LC-1) — **the model never executes a write**; the confirmed
  postback runs the exact same command path with the same permission/SoD checks. No confirm = no
  action.
- **`ask <คำถาม>`** — read-only analytics Q&A bridging to `modules/nl-analytics` (NL → governed
  query), answering in chat with the same tenant scoping + permission gates as the web `/query`
  screen; refuses rather than guesses when the question needs data the user can't see.
- Guardrails recorded up front: intent parsing applies ONLY to messages from **linked staff** that
  the command router did not match AND that start with a wake word (`bot` / `บอท`) — customer chat
  stays untouched; AI cost is bounded per user/day; every AI-drafted action is flagged
  `via:'ai-draft'` in the audit trail.
- **Docs:** PN-26 §AI note + PN-02 §7 step-2 addendum (AI drafts confirm into the same entry
  controls) + manual 03/09 + UAT cases (draft→confirm happy, no-confirm no-action, wake-word
  scoping, `ask` permission negative). **Harness:** line-crm with the AI layer mocked
  (deterministic intent fixtures — mirrors the `ai-eval` harness pattern).

## 2. Explicitly out of scope (this plan)
- Chat approval for PO / AP payments / any GL-posting decision (PR approval stays the only chat
  decision until the LC-2 retro reviews the postback-approve evidence).
- LIFF mini-app forms (full web-in-LINE) — the `/m` member LIFF pattern exists, but staff flows keep
  plain chat + web for now.
- Customer-facing chat commands (the OA stays a free customer channel; silence on non-commands is a
  feature).

## 3. Sequencing & gates

| Phase | Ships | Gate |
|---|---|---|
| LC-1 | flex + postback approve (+confirm), carousel | line-crm extended; full CI matrix green |
| LC-2 | expense/advance raise via chat + EXP-07/08 notifications | line-crm + basics (petty-cash GL untouched by chat) green |
| LC-3 | leave via chat, admin link registry + force-unlink, rate limit | line-crm + compliance green |
| LC-4 | alert/report subscriptions to LINE, daily digest | line-crm + bi harness green |
| LC-5 | Thai NL copilot (confirm-first drafts) + `ask` analytics | line-crm (AI mocked) + ai-eval green |

Each phase lands as its own PR with the narrative/manual/UAT/matrix synced in the same commit series,
per the repo documentation-sync policy. No phase adds an RCM control unless the LC-2 controls review
concludes chat money-approval needs one.

## 4. Revision history

| Version | Date | Author | Summary |
|---|---|---|---|
| 1.0 | 2026-07-03 | Platform | **LC-5 delivered — plan complete.** `ask` → governed nl-analytics under the same permission gate (top-5 summary, honest empty answers); wake-word copilot drafts PRs (deterministic rules + optional DPA-gated LLM refinement) and executes ONLY via the LC-1 confirm postback replaying the ordinary command path; AI-origin audit markers chat_ai/chat_ai_confirm. Deviation noted: intent rules live beside the webhook (doc-ai key-less pattern) rather than reusing ai-action's propose/approve (that flow targets human approvers, not self-confirmation). `line-crm` 85 ✓; PN-26 rev 1.7 + PN-02 rev 2.0; UAT-P2P-085 + UAT-RPT-047. |
| 0.6 | 2026-07-03 | Platform | **LC-4 delivered** — report-subscription recipients accept `{line_user}` (LINE summary delivery via LineNotifyService); new `line_daily_digest` action report (approvals/PRs/alerts counts) with chat `subscribe digest`/`unsubscribe digest` opt-in (permission-at-subscribe dashboard/fin_report/exec); alert rules resolve `target_to:'user:<name>'` to the linked LINE at send time. Deviation noted: opt-in rides the tenant's digest subscription recipients (no user_prefs change needed). `line-crm` 80 ✓; PN-26 rev 1.6; UAT-RPT-046. |
| 0.5 | 2026-07-03 | Platform | **LC-3 delivered** — `leave` chat raise via `EssService.requestLeave` (ess perm + employee link; approver push on the /api/hcm gate perms, requester ✅ on approve); admin link registry `GET /api/line/links` + force-unlink `DELETE /api/line/links/:username` (perm `users`, masked ids, audit rows); per-LINE-user rate limit (env-tunable, one throttle reply then silent drop, audited). `line-crm` 75 ✓; PN-08 rev 1.7 + PN-25 rev 0.9; UAT-SEC-048 + UAT-PAY-038. |
| 0.4 | 2026-07-03 | Platform | **LC-2 delivered** — `expense`/`advance` chat raise via the same `PettyCashService.createRequest` path (creditors/exec re-checked per command; FUND_CLOSED/INSUFFICIENT_FLOAT unchanged); `LineNotifyService.notifyPermissionHolders` pushes creditors/exec holders (maker excluded) on request + requester on decision; chat money-decisions stay deferred. `line-crm` 69 ✓; PN-07 rev 1.0; UAT-P2P-084. |
| 0.3 | 2026-07-02 | Platform | **LC-1 delivered** — flex queue card (`buildApproveCard`) with postback [อนุมัติ]/[ปฏิเสธ], nonce'd 5-min confirm state consumed before acting (replay-safe), same `chatDecision`→engine path (SoD verified over buttons), `my prs` carousel, `replyLineFlex`. `line-crm` 64 ✓; PN-02 rev 1.9; UAT-P2P-083. |
| 0.2 | 2026-07-02 | Platform | Added LC-4 (alert/BI-report subscriptions + daily digest over the existing alerts `line` channel and BI scheduler) and LC-5 (confirm-first Thai NL copilot + `ask` analytics over `modules/ai` + `nl-analytics`). |
| 0.1 | 2026-07-02 | Platform | Initial plan — follows delivered 0227/0228 LINE chat work (#333, #335). |
