# 30 — LINE Chat Workbench: Rich Interactions, Money Self-Service & Governance — Design & Roadmap

> **Date:** 2026-07-02 · **Status:** v0.1 — PLANNED · **Owner:** ERP / Product
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
  signature-verified per-tenant webhook, staff identity binding (`users.line_user_id`, one-time code,
  migration `0227`), linear token command router, per-command `resolvePermissions` re-check,
  LINE message-id dedupe (`message_log.provider_ref`), reply via `replyLine`.
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

### LC-1 — Rich interactions: flex cards + one-tap postback approve
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

### LC-2 — Petty-cash & expense self-service (EXP-07/08 channel extension)
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

### LC-3 — ESS leave + channel governance (ITGC-AC)
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

Each phase lands as its own PR with the narrative/manual/UAT/matrix synced in the same commit series,
per the repo documentation-sync policy. No phase adds an RCM control unless the LC-2 controls review
concludes chat money-approval needs one.

## 4. Revision history

| Version | Date | Author | Summary |
|---|---|---|---|
| 0.1 | 2026-07-02 | Platform | Initial plan — follows delivered 0227/0228 LINE chat work (#333, #335). |
