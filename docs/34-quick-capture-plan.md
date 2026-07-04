# 34 — Quick Capture lane (paypers-style bill capture) + doc-AI image extraction

> **Date:** 2026-07-04 · **Status:** v1.2 — IMPLEMENTED (Phases 1–4) · **Owner:** Web / Product / Platform
> **Scope:** Make capturing a supplier bill as frictionless as [paypers.ai](https://paypers.ai/) — *snap a
> photo, done* — by opening the **existing** AP-intake engine (EXP-10) to **every staffer** through a
> dead-simple `/capture` screen, and by exposing the doc-AI image/PDF extractor as a first-class endpoint.
> **No new control, no GL change, no schema change** — an entry extension of EXP-10 that preserves SoD.
> Builds on [`16-peak-style-erp-convergence.md`](./16-peak-style-erp-convergence.md) (usability lineage)
> and the EXP-10 AP-intake pipeline in [`02-procure-to-pay.md`](./process-narratives/02-procure-to-pay.md).

---

## 0. Why (one paragraph)

Users compared us to **paypers.ai**, whose whole value is *effortless capture*: send a bill via LINE / email
/ Drive, AI reads it, "3 hours → 3 minutes". We already have the hard part — the AP-intake engine extracts
image/PDF invoices (Claude vision + a deterministic PDF text-layer path), stores the source document, auto-maps
the PO, dedups, and runs the 3-way match (EXP-10). But that engine sits **behind `procurement`/`creditors`**
and inside an enterprise pipeline, so a regular staffer holding a paper bill can't get it into the system
without Accounting. The gap is **the front door**, not the engine.

## 1. Phasing

| Phase | What | Status |
|---|---|---|
| **2 — doc-AI accepts images** | Expose the existing vision extractor as `POST /api/doc-ai/extract-document` (base64 `data:` URL). Extract-only, no persistence, no GL. The reusable primitive behind capture + the future LINE channel. | ✅ this PR |
| **3 — Quick Capture lane** | A `pr_raise`-gated `POST /api/procurement/ap-intake/capture` (draft-only) + `GET …/mine`, and a phone-friendly `/capture` screen: snap/upload → AI reads → filed for Accounting. | ✅ this PR |
| **1 — LINE capture channel** | Type `บิล` in the shop LINE OA then send a bill photo → webhook parks a pending state → the photo routes to `ApIntakeService.capture`. Reuses the LINE infra (docs/30) + the capture engine. | ✅ shipped |
| **4 — Email-to-capture** | Forward a bill to the per-tenant capture inbox → inbound-email webhook resolves the verified sender and routes each attachment to `ApIntakeService.capture`. New `email-capture` module + a verified send-from identity on `users` (migration 0245). | ✅ shipped |

*(The user asked to ship 2 + 3 first, then 1, then 4 — hence the ordering.)*

### 2.4 LINE capture channel (Phase 1)
A linked staffer types **`บิล`** (`capture`) in the shop LINE OA chat; `LineWebhookService.chatCaptureStart`
checks the same `pr_raise` gate and parks a `line_chat_states` pending state (10-min TTL, one per user). The
**next photo** (`onChatImage` → `onCaptureImage`) is fetched from the LINE content API and routed to
`ApIntakeService.capture` — the **same draft-only** result as the web lane (NeedsReview, file stored, never
books/GL). Webhook redelivery is deduped on the message id; a stray photo with no pending state is ignored
(customers send images all day). `line_chat_states.kind` is a plain text column, so **no migration** — the
existing `attach` flow and the new `capture` flow share the one pending-state row (routed by `kind`).

### 2.5 Email-to-capture channel (Phase 4)
New module `email-capture`. **Identity:** a staffer verifies the address they forward bills *from* — `POST
/api/capture-email/register {email}` mails a 6-digit code (best-effort via a private Nodemailer transport;
the code is stored so registration survives an SMTP outage, never returned in the API body), `POST
/api/capture-email/verify {code}` confirms it. Stored on `users` (migration **`0245`** — `capture_email` /
`capture_email_code` / `capture_email_expires_at`, an ALTER only → no RLS loop; verified ⇔ `capture_email`
set + code NULL), mirroring the LINE link columns. **Inbound:** each tenant has a capture inbox
(`capture-<shop>@$CAPTURE_EMAIL_DOMAIN`); the provider's inbound-parse (SendGrid / Mailgun / Postmark) posts
the normalized mail to `POST /api/email/inbound/<shop>` (`@Public`/`@NoTx`, per-tenant shared secret via
`TenantMessagingService.resolveCreds(_, 'email')` — same fail-closed-in-prod stance as the LINE webhook;
redelivery-deduped on `message_id` through `message_log`). The webhook resolves the **verified sender** in
that tenant, checks **`pr_raise`**, and routes each image/PDF attachment (shared `INVOICE_DOC_MIME`
allow-list) to `ApIntakeService.capture` — **draft-only**, attributed to the sender. Unknown/unverified
sender or missing `pr_raise` ⇒ **no draft** (`skipped: unknown_sender | no_permission`), preserving
attribution + SoD. `/capture` gains a verify + inbox-address card. New env: `CAPTURE_EMAIL_DOMAIN`,
`CAPTURE_EMAIL_FROM`.

## 2. What shipped (Phases 2 + 3)

### 2.1 doc-AI image/PDF extraction (Phase 2)
`POST /api/doc-ai/extract-document` (`@Permissions('pr_raise','procurement','creditors','exec')`) →
`DocAiService.extractFromDataUrl`. Parses + validates the `data:` URL via the new shared
`common/invoice-doc.ts` (`parseInvoiceDataUrl`, one MIME allow-list + size caps for every intake surface),
then runs the same `extractInvoiceDocument` the AP-intake upload channel uses (PDF text-layer → deterministic
rules; photo/scan → Claude vision when keyed, else an **honest empty** draft — never a guess). Returns
`{fields, source}` — **extract-only, never persists, never touches the GL.**

### 2.2 Quick Capture lane (Phase 3)
- **API** — `POST /api/procurement/ap-intake/capture` (`@Permissions('pr_raise','procurement','creditors')`)
  → `ApIntakeService.capture`, which is the existing `createFromFile` (extract → file a **NeedsReview/Mapped
  draft** with the source document stored). It **never books a bill and never posts to the GL**.
  `GET /api/procurement/ap-intake/mine` returns the capturer's **own** submissions only (scoped to
  `created_by` + tenant). Mapping / posting / the full worklist stay `procurement`/`creditors`.
- **Web** — `/capture`: two big buttons (**ถ่ายรูปบิล** with `capture="environment"`, **เลือกไฟล์ / PDF**),
  a result card showing what AI read, and a "บิลที่คุณเพิ่งเก็บ" list with status badges. Mobile-first.
- **Nav** — `nav.ap_capture` → `/capture` in the Procurement group, cross-listed to **BOTH** ERP + POS
  surfaces (like `requisitions`), so any staffer reaches it without switching workspaces.

### 2.3 Why `pr_raise` (the control decision)
`pr_raise` is the existing **company-wide, low-risk** duty ("raise a purchase requisition"), seeded into every
internal staff role, implied by `procurement`, and **absent from every SoD rule**. Capturing a bill into a
review inbox is the same shape of maker-side, no-financial-effect action, so we reuse it — **no new
permission, no SoD change, no RCM regeneration**. The control boundary is unchanged: the capturer (maker) can
never book or pay (checker), because posting stays `creditors` (EXP-06).

## 3. Control / compliance impact — **none new**

This is an **entry extension of EXP-10**. Capture files a draft with no GL effect; every downstream
control — auto-map ambiguity → NeedsReview, duplicate refusal, cumulative one-PO-one-bill guard, the 3-way
match, and the AP-PAY maker-checker (EXP-06) — is **byte-for-byte unchanged**. SoD is actively **strengthened
in evidence**: the harness now asserts a `pr_raise`-only capturer is **403** on both `POST …/:no/post` and
the full `GET …/ap-intake` worklist. Therefore the **RCM (176 controls), control matrices and harnesses
are not modified** (per the doc-sync policy's "say so explicitly" clause), other than the added ToE below.

**Docs updated:** this file; narrative `02-procure-to-pay.md` (§7 step 9½ + access map + rev 3.1); user
manual `03-procurement.md` (Quick Capture how-to); UAT `03-procure-to-pay-uat.md` (UAT-P2P-101/102) +
traceability matrix.

## 4. Verification

- `pnpm -r typecheck` ✅ · `pnpm --filter @ierp/api build` ✅ · `pnpm --filter @ierp/web build` ✅ (`/capture`
  route compiles).
- `match` harness **45 ✓** — new: capture files a NeedsReview draft + `/mine` visibility; capturer's
  `POST …/:no/post` **403** and full-worklist `GET` **403** (SoD). The existing upload type/size gates still
  pass after the `parseInvoiceDataUrl` refactor.
- `ext` harness **268 ✓** — new: `extract-document` on an image → honest-empty draft (`source: none`);
  unsupported type → **400 `UNSUPPORTED_FILE_TYPE`**.
- `basics` **234 ✓** (no AP/GL regression).
- `line-crm` **136 ✓** — LINE: `บิล` + photo → a NeedsReview draft filed from the LINE content API
  (`created_by` = the linked staff, file stored); a linked user without `pr_raise` is refused. Email:
  register→verify→inbound bill → a draft attributed to the verified sender; redelivery / unknown-sender /
  no-`pr_raise` each file no draft.
- `migration-parity` **✓** (246 migrations, filename-order == journal-order) + migrations-journaled gate green
  for `0245`.

## Revision history

| Date | Version | Author | Change |
|---|---|---|---|
| 2026-07-04 | v1.2 (IMPLEMENTED — Phase 4) | Platform | **Email-to-capture channel.** New `email-capture` module: verify a send-from address via a mailed 6-digit code (`/api/capture-email/register`+`/verify`+`/status`; `users.capture_email*`, migration `0245`), and an inbound webhook `POST /api/email/inbound/<shop>` (`@Public`/`@NoTx`, per-tenant secret, redelivery-deduped) that resolves the verified sender, gates on `pr_raise`, and routes each attachment to `ApIntakeService.capture` (draft-only, attributed to the sender). `/capture` web adds a verify + inbox card. Env `CAPTURE_EMAIL_DOMAIN`/`CAPTURE_EMAIL_FROM`. No new control (entry extension of EXP-10); RCM unchanged. ToE: `line-crm` 136 ✓, `migration-parity`/journaled ✓, `basics` 234 ✓. Docs synced (narrative 3.3, manual, UAT-P2P-104 + matrix). |
| 2026-07-04 | v1.1 (IMPLEMENTED — Phase 1) | Platform | **LINE capture channel.** `บิล`/`capture` command in the shop LINE OA parks a `line_chat_states` pending state; the next photo (`onChatImage`→`onCaptureImage`) is fetched from the LINE content API and routed to `ApIntakeService.capture` (draft-only, same `pr_raise` gate + SoD as the web lane). Shares the pending-state row with the `attach` flow (routed by `kind`; no migration). ToE: `line-crm` 132 ✓. Docs synced (narrative 3.2, manual, UAT-P2P-103 + matrix). |
| 2026-07-04 | v1.0 (IMPLEMENTED — Phases 2+3) | Web / Product / Platform | doc-AI `POST /api/doc-ai/extract-document` (image/PDF, extract-only); Quick Capture `/capture` + `POST /api/procurement/ap-intake/capture` (`pr_raise`, draft-only) + `GET …/mine`; shared `common/invoice-doc.ts`; nav `nav.ap_capture`. Entry extension of EXP-10, no new control / GL / schema. ToE: `match` 45 ✓, `ext` 268 ✓, `basics` 234 ✓. Docs synced (narrative 3.1, manual, UAT 101/102 + matrix). Phase 1 (LINE capture channel) to follow. |
