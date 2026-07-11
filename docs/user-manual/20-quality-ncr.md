# 20 — Quality: Non-Conformance (NCR) Register (ของไม่เป็นไปตามข้อกำหนด)

**Who this is for:** Quality staff who raise non-conformances; Quality Approvers / Cost Accountants / Executives who approve dispositions
**Screen:** `/quality/ncr` (found under **Production** in the sidebar)
**Required permission:** `quality` (raise an NCR, view the register, maintain defect codes) · `quality_approve` or `exec` (approve/reject a financial disposition)

A **Non-Conformance Report (NCR)** records defective material found at incoming inspection, during
production, or reported by a customer/supplier — and controls what happens to it. The key rule (control
**QC-01**) is **maker-checker**: whoever *raises* an NCR can never *approve its financial disposition*
(scrapping it, using it as-is, or returning it). A **different** person must approve, because a scrap
disposition writes the stock off to loss in the general ledger. This closes the old gap where an inspector
could scrap stock with no second signature.

---

## 20.1 The NCR lifecycle

An NCR moves through four states:

1. **Open** — raised, no financial decision yet.
2. **Pending disposition** — a financial disposition (scrap / use-as-is / return) has been *proposed* and is
   waiting for a **different** person to approve it.
3. **Dispositioned** — approved and applied; if the decision was **scrap**, the inventory write-off has been
   posted to the ledger.
4. **Closed** — locked; no further action.

---

## 20.2 Add defect codes (once)

Open the **รหัสข้อบกพร่อง (Defect codes)** tab. Enter a **code** (e.g. `DIM-01`), an optional name and
category (dimensional / cosmetic / functional / documentation), and press **เพิ่มรหัส (Add code)**. Codes are
per-company and become the reason list when raising an NCR. (Requires the `quality` duty.)

## 20.3 Raise an NCR

Open the **ออก NCR (Raise NCR)** tab and fill in:

- **Source** — incoming, in-process, customer, or supplier.
- **Ref type / Ref document** — optionally link a work order (`WO`) or goods receipt (`GR`) and its number.
- **Item, defect code, severity** (minor / major / critical), **quantity**, and **unit cost**.
- **Proposed disposition** — leave blank to just log the issue (stays **Open**), or choose **scrap /
  use-as-is / return** to send it for approval (goes to **Pending disposition**). *Rework* is not a financial
  disposition and does not require approval.

Press **ออก NCR (Raise NCR)**. The system assigns a number like `NCR-00001`.

> **Tip — promote a failed inspection.** A failed quality inspection can be turned into an NCR directly
> (`POST /api/quality/inspections/:id/promote`), carrying over the item, the failed quantity and the source
> document.

## 20.4 Approve or reject a disposition (a DIFFERENT person)

Open the **ทะเบียน NCR (NCR register)** tab. Rows in **Pending disposition** show **อนุมัติจัดการ (Approve
disposition)** and **ปฏิเสธ (Reject)** buttons (visible to `quality_approve` / `exec` users).

- **Approve** applies the disposition. If it is **scrap**, the system posts the write-off automatically:
  **Dr 5810 Scrap / Rework Loss** and **Cr** the source inventory account (work-order stock → 1250 WIP,
  goods-receipt stock → 1200 Raw Materials, otherwise → 1210 Finished Goods). The NCR shows the write-off
  value and the journal-entry number (`JE-…`). Use-as-is and return apply with no write-off.
- **Reject** returns the NCR to **Open** so it can be re-assessed.

If you try to approve or reject an NCR **you raised yourself**, the system refuses with
**`SOD_SELF_APPROVAL`** — a different approver must act.

## 20.5 Close an NCR

Once **Dispositioned**, press **ปิด (Close)** to lock the record.

---

## Control & troubleshooting

| Message | Meaning | What to do |
|---|---|---|
| `SOD_SELF_APPROVAL` | You raised this NCR, so you cannot approve/reject its disposition (QC-01 maker-checker) | Ask a different `quality_approve` / `exec` colleague to act |
| `NCR_NOT_PENDING` | The NCR is not awaiting a disposition | Refresh; only *Pending disposition* NCRs can be approved/rejected |
| `NCR_NOT_DISPOSITIONED` | Trying to close an NCR that was not dispositioned | Disposition it first |
| `BAD_DISPOSITION` | Disposition must be scrap / use-as-is / return | Pick a valid financial disposition |
| `INSPECTION_NOT_FAILED` | Promoting an inspection with nothing failed | Only failed inspections can become an NCR |
| `DEFECT_CODE_EXISTS` | The defect code already exists for your company | Use a unique code |

**Control reference:** QC-01 (NCR disposition maker-checker) · Segregation of Duties **R21** (raiser ≠
disposition approver). Process narrative: `docs/process-narratives/15-manufacturing-costing.md` §7 (13).
