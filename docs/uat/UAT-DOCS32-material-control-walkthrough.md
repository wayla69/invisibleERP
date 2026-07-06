# UAT walkthrough — Project material control (web tabs) · docs/32

**Status: v1.0 · 2026-07-04** · Cycle: Order-to-Cash / Procure-to-Pay (project delivery) · Narrative: PN-16
**Scope:** the four material-control tabs on the project workspace `/projects/{code}` — **BoQ & งบวัสดุ**,
**ขอเบิกวัสดุ**, **จองสต๊อก**, **เงินสดหน้างาน** (docs/32 M0–M4 + follow-ups FU1–FU4).

This is a **hands-on, click-through** script to run with the team in a UAT session — screen by screen, in order,
each step with what to click and what you should see. It exercises the happy path **and** the built-in controls
(maker-checker, budget ceiling, over-budget LINE approval, no-double-allocation). The API-level control cases
(`projects.ts` harness; UAT-O2C-229..234) remain the machine-verified source of truth; this doc is the human
acceptance pass over the UI.

---

## 0. Before you start (≈5 min)

| You need | Why |
|---|---|
| **Two logins**: a project **controller/maker** (author) and a **different** approver with `procurement`/`exec` | maker-checker steps refuse self-approval |
| A **project** (e.g. `PRJ-DEMO`) you can open at `/projects/PRJ-DEMO` | the workspace host |
| One inventory **item on hand** at a warehouse (e.g. `STEEL` @ `WH-MAIN`) | the reservation tab |
| One **petty-cash fund** established (`/finance/petty-cash`) | the site-cash *ขอเงินสดย่อย* action |
| A finance login with `creditors`/`exec` | raising an advance |

Open the project, then click across the tabs: **ภาพรวม · กำหนดการ · หมุดหมาย · ทรัพยากร · ความเสี่ยง ·
BoQ & งบวัสดุ · ขอเบิกวัสดุ · จองสต๊อก · เงินสดหน้างาน · กำกับดูแล · ต้นทุน & บิล**. The four bolded tabs are
what we test below. Each tab is deep-linkable (`?tab=boq`, `?tab=requisitions`, `?tab=reservations`, `?tab=sitecash`).

---

## 1. BoQ & งบวัสดุ — build and lock the material budget (M0 · FU1)

| # | Do this (as the **maker**) | Expect on screen |
|---|---|---|
| 1.1 | Open the **BoQ & งบวัสดุ** tab on a project with no BoQ. Click **สร้าง BoQ**, give it a title, **สร้าง**. | Empty-state disappears; a **ร่าง (draft)** BoQ header appears with 0 lines. |
| 1.2 | **เพิ่มรายการ** → category *วัสดุ*, description, qty `100`, unit `ม³`, rate `150`. The dialog previews **งบรายการ = ฿15,000**. **เพิ่ม**. | Line #1 in the table; **งบ BoQ รวม** tile = ฿15,000; each line shows **งบ / ผูกพัน / คงเหลือ** (15,000 / 0 / 15,000). |
| 1.3 | Add a second line (labor 20 × 500). | Total tile updates to ฿25,000. |
| 1.4 | Click **อนุมัติ** **while logged in as the maker**. | **Blocked** — error toast `SOD_SELF_APPROVAL` ("ผู้จัดทำ BoQ อนุมัติเองไม่ได้"). The budget is *not* synced. ✅ control |
| 1.5 | Log in as the **approver**, reopen the tab, **อนุมัติ**. | Status badge → **อนุมัติแล้ว**; success toast shows the synced budget; the project header budget = ฿25,000. |
| 1.6 | On a line, click the re-measure icon, enter actual qty `110`, **บันทึก**. | The **วัดจริง** column shows 110. |
| 1.7 | Click **ล็อก**, then try re-measure again. | Status → **ล็อก**; re-measure now refused (`BOQ_LOCKED`). ✅ control |

> **Acceptance:** a BoQ can only be approved by someone other than its author, approval sets the enforceable
> project budget, and a locked BoQ is frozen. Per-line remaining is visible.

---

## 2. ขอเบิกวัสดุ — requisition draw, budget ceiling & over-budget LINE approval (M1 · M2 · PROJ-12/13)

Use a line with a known remaining (say a **CEMENT** line, budget ฿15,000, remaining ฿15,000).

| # | Do this | Expect on screen |
|---|---|---|
| 2.1 | **ขอเบิกวัสดุ** tab → **ขอเบิกวัสดุ**. Pick the CEMENT line (dropdown shows **คงเหลือ ฿15,000**), qty `10`, unit cost `100` (มูลค่า ฿1,000). **ส่งคำขอ**. | Row appears with route badge **ใบขอซื้อ** (or **เบิกสต๊อก** if the item is on hand — FU2) and `linked_doc_no` a PR/issue number. The KPI band shows the new commitment. |
| 2.2 | Raise another draw on the same line, qty `100` × `100` = **฿10,000** — over the remaining. **ส่งคำขอ**. | Row route badge = **เกินงบ** (red), status **pending**, **ส่วนเกินงบ** column shows the overage. A one-tap **LINE** approval card is pushed to the authoriser. ✅ control |
| 2.3 | On the pending row, click the **approve** (✓) icon **as the requester**. | **Blocked** — `SOD_SELF_APPROVAL`. ✅ control |
| 2.4 | Approve **as a different authoriser** (the ✓ icon, or one-tap in LINE). | Status → **approved**; a **Draft** project-tagged PO is auto-drafted (`linked_doc_no` a `PO-…`). |
| 2.5 | Go back to the **BoQ** tab and read the CEMENT line. | The line now shows **คงเหลือ** negative (the authorised overage) — the overage was allowed only *through* approval. |
| 2.6 | **(Requester shop surface)** As a plain `pr_raise` requester, open `/shop`, use the **ซื้อเข้าโครงการ** picker (or the *Shop for this project* button on the project page) and pick this project. | A shop opens listing **only** the project's approved-BoQ material lines, each with its **remaining budget**. Add a line and **ส่งใบขอเบิกวัสดุ** — it raises the same PMR (within budget → routed; over budget → the authoriser flow above). An item **not** on the approved BoQ is **not shown** and cannot be added. ✅ control |
| 2.7 | **(Scope-change request — PROJ-15)** On the project shop, click **ขอเพิ่มวัสดุเข้างบ**, enter an item that is NOT on the BoQ (name, qty, expected price) and **ส่งคำขอ**. Then try the same for an item that IS already on the BoQ. | The off-budget request is filed **pending** (shown in *คำขอเพิ่มวัสดุ* with a รออนุมัติ badge) and the item is **still not shoppable**. The already-budgeted item is refused (`ITEM_ALREADY_BUDGETED`). ✅ control |
| 2.8 | Approve the pending request **as the requester** → then **as a planner/exec** (the inline อนุมัติ button, or `POST /api/pmr/boq-request/:reqNo/approve`). | Self-approve is **blocked** (`SOD_SELF_APPROVAL`). The independent approval **appends a new line to the approved BoQ**, grows the project budget, and the item now **appears on the shelf** ready to shop. ✅ control |

> **Acceptance:** within-budget draws flow straight through; a draw that would breach the BoQ line is held and
> requires a *different* authoriser (one-tap on LINE), whose approval drafts the PO. Nothing overruns silently.
> The `/shop` project surface (2.6) lets a requester who cannot see the project/BoQ endpoints shop only what the
> approved budget allows — an off-budget item is never offered (`GET /api/pmr/projects`, `GET /api/pmr/project/:code/boq`).
>
> **Tolerance note (FU1):** if the project was created with an **over-budget tolerance %**, a draw within that
> band of the line budget proceeds without the approval step. Set it to `0` for a strict ceiling.

---

## 3. จองสต๊อก — reserve on-hand stock and issue it to the project (M3 · INV-13)

Item `STEEL`, on hand `100` @ `WH-MAIN`.

| # | Do this (as **warehouse** `wh_custody`) | Expect on screen |
|---|---|---|
| 3.1 | **จองสต๊อก** tab → **จองสต๊อก**. Enter item `STEEL`, warehouse `WH-MAIN`, qty `30`, optionally a BoQ line. The dialog shows **พร้อมจ่าย (available-to-issue): 100**. **จอง**. | A reservation row, status **held**, qty 30. Summary **จองอยู่ (held)** = 30. |
| 3.2 | Reserve again, qty `80` (30 held + 80 > 100). | **Blocked** — `INSUFFICIENT_STOCK`; no reservation created (no double-allocation). ✅ control |
| 3.3 | On the held row, click **issue-to-project** (✓). | Status → **consumed**, an **เลขที่จ่าย** appears. Value moves **Dr 1260 project WIP / Cr 1200 Inventory** (confirm on the **ต้นทุน & บิล** tab / trial balance). |
| 3.4 | Reserve 20 more, then click **release** (←) on that hold. | Reservation **released**; the held qty is freed. |

> **Acceptance:** stock is reserved against real availability (never over-allocated), and issuing relieves
> inventory into project WIP with the project dimension on the GL.

---

## 4. เงินสดหน้างาน — manage & raise site cash on the project (M4 · FU4 · PROJ-14)

| # | Do this | Expect on screen |
|---|---|---|
| 4.1 | **เงินสดหน้างาน** tab. Read the four tiles (advances / reimbursements / petty cash / total) and the two tables. | Read-only rollup of everything raised **against this project**. |
| 4.2 | Click **ออกเงินทดรอง** (as finance `creditors`/`exec`). Payee, amount `2,000`, optionally link a **BoQ line**. **ออกเงินทดรอง**. | Success toast; the advance appears in the **Advances** table and the **เงินทดรองจ่าย** tile rises. The GL advance line carries the project dimension. |
| 4.3 | Click **ขอเงินสดย่อย**. Pick a **fund** (dropdown shows each fund's balance), kind *expense*, payee, amount `500`, optionally a BoQ line. **ส่งคำขอ**. | Toast "รออนุมัติ"; the request lands in the **petty cash** section as pending — routed to maker-checker approval (approve in `/finance/petty-cash` by a *different* user). |
| 4.4 | If you linked either to a BoQ line, settle the advance (or approve the petty-cash request) in finance, then return to the **BoQ** tab. | The linked BoQ line's **คงเหลือ** drops by the settled/approved amount — site cash **consumes** the same budget ceiling (FU1). ✅ control |

> **Acceptance:** project cash is both **visible** and **raiseable** from the project — an advance or petty-cash
> request can be filed here, tagged to the project (and optionally a BoQ line so it draws the same budget), and
> flows into the normal finance approval path.

---

## 5. Sign-off

| Section | Tester | Date | Pass / Fail | Notes |
|---|---|---|---|---|
| 1. BoQ & งบวัสดุ | | | | |
| 2. ขอเบิกวัสดุ | | | | |
| 3. จองสต๊อก | | | | |
| 4. เงินสดหน้างาน | | | | |

**Exit criteria:** all four sections **Pass**, with each ✅-marked control observed to block as described. Any Fail
is logged as a defect against the relevant control (PROJ-12/13/14, INV-13) and re-tested after fix.

---

## Revision history
| Version | Date | Notes |
|---|---|---|
| 1.0 | 2026-07-04 | Initial team walkthrough for the docs/32 material-control web tabs (M0–M4 + FU1–FU4), including the FU4 raise-site-cash actions. Complements the API-level cases UAT-O2C-229..234. |
| 1.1 | 2026-07-05 | Added step **2.6** — the `pr_raise` requester **shop-for-a-project** surface (`/shop` → *ซื้อเข้าโครงการ* → `/shop/project/[code]`): shops only the approved-BoQ material lines with remaining budget and checks out into the same PMR; an off-budget item is never offered. Backed by `GET /api/pmr/projects` + `GET /api/pmr/project/:code/boq` (`pr_raise`-safe). No new control; ToE in the `projects` harness. Cross-ref PN-16 rev 0.34. |
| 1.2 | 2026-07-05 | Added steps **2.7–2.8** — the **material scope-change request** (PROJ-15): a requester proposes an off-budget item (`POST /api/pmr/boq-request`; `ITEM_ALREADY_BUDGETED` guard), it parks pending and isn't shoppable until an independent authoriser (`planner`/`exec`, ≠ requester → `SOD_SELF_APPROVAL`) approves, appending a new BoQ line + growing the budget so the item becomes shoppable. New table `project_boq_change_requests` (migration 0249); ToE in the `projects` harness. Cross-ref PN-16 rev 0.35. |
