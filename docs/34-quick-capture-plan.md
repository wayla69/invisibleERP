# 34 — Quick Capture lane (paypers-style bill capture) + doc-AI image extraction

> **Date:** 2026-07-04 · **Status:** v1.0 — IMPLEMENTED (Phase 1) · **Owner:** Web / Product / Platform
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
| **1 — LINE capture channel** | Send a bill photo to the shop LINE OA → webhook → `extractFromDataUrl` → capture draft. Reuses the LINE infra (docs/30) + both endpoints above. | ⏭ next |

*(The user asked to ship 2 + 3 first, then 1 — hence the ordering.)*

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

## Revision history

| Date | Version | Author | Change |
|---|---|---|---|
| 2026-07-04 | v1.0 (IMPLEMENTED — Phases 2+3) | Web / Product / Platform | doc-AI `POST /api/doc-ai/extract-document` (image/PDF, extract-only); Quick Capture `/capture` + `POST /api/procurement/ap-intake/capture` (`pr_raise`, draft-only) + `GET …/mine`; shared `common/invoice-doc.ts`; nav `nav.ap_capture`. Entry extension of EXP-10, no new control / GL / schema. ToE: `match` 45 ✓, `ext` 268 ✓, `basics` 234 ✓. Docs synced (narrative 3.1, manual, UAT 101/102 + matrix). Phase 1 (LINE capture channel) to follow. |
