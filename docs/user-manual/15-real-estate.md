# 15 — Real Estate (Developer) — Unit Sales

> **Who sees this:** only users granted the **`re_sales`** (sales agent) or **`re_contract_approve`** (sales
> manager) permissions. A non-property tenant never grants these, so the module stays hidden. Property revenue
> is recognised at **ownership transfer** (a fast-follow); everything below is the pre-transfer sales lifecycle.
> Related: process narrative PN-31, plan `docs/35`.

## Developments & units (`POST /api/realestate/developments`, `…/:code/units`)
Create a **development** (a project of units) and add **units** to it (unit no, type, area, floor, **list
price**). Each unit has a status — **available → reserved → contracted → transferred**. The **availability
grid** (`GET /api/realestate/developments/{code}/units`) shows the live count in each state and the price list.
A unit is never double-sold: the system blocks a second booking/contract on the same unit (**RE-01**).

## Booking a unit (`POST /api/realestate/bookings`)
A buyer reserves a unit with a **deposit** — the unit flips to **reserved** and the deposit is banked as a
customer deposit (Dr cash / Cr customer deposits 2210). Booking a unit that isn't **available** returns
`UNIT_NOT_AVAILABLE`.

## Sale contract — maker-checker (`POST /api/realestate/contracts`, `…/{no}/approve`)
An agent **drafts** the sale contract: **price = list price − discount**, a **down-payment**, and the number of
**installments**. Drafting posts nothing. A **different** person — the sales manager (`re_contract_approve`) —
**approves** it (a drafter approving their own contract is blocked, `SOD_SELF_APPROVAL`; **RE-02**, SoD R19).
On approval the unit becomes **contracted**, the **down-payment posts to the contract liability** (the booking
deposit is reclassed in), and the **installment schedule** is generated. Troubleshooting: `BAD_DISCOUNT`
(discount over the list price), `BAD_DOWN_PAYMENT` (down-payment over the price or below the booking deposit),
`CONTRACT_NOT_DRAFT`, `UNIT_NOT_CONTRACTABLE`.

## Installments (`POST /api/realestate/installments/{id}/pay`)
Record a buyer's installment payment — it must be the **exact scheduled amount** (`BAD_AMOUNT`) and each
installment is paid **once** (`INSTALLMENT_PAID`); the cash posts to the contract liability (Dr cash / Cr 2410;
**RE-03**). The contract view (`GET /api/realestate/contracts/{no}`) shows the schedule with **paid /
outstanding** so the buyer's position is always clear.

## Ownership transfer (`POST /api/realestate/contracts/{no}/transfer`)
Once the buyer has **fully paid** (down‑payment + all installments), an authorised user (`re_transfer`)
**transfers ownership**: this is when the sale's **revenue is recognised** (the deferred cash in the contract
liability moves to revenue) and the unit's construction **cost is relieved** — the unit and contract flip to
**transferred**. You can't transfer a contract with any outstanding balance (`NOT_FULLY_SETTLED`). Set a unit's
**cost** when adding it so the cost is matched at transfer. Scheduled jobs handle **booking expiry** and an
**overdue‑installment** worklist automatically.

> **Open by dropdown, not by typing:** on `/realestate` the **เปิดโครงการ (RED-…)** and
> **ดูสัญญา (REC-…)** boxes are dropdowns fed by the new read-only lists
> `GET /api/realestate/developments` and `GET /api/realestate/contracts` (name/buyer + status
> shown; **พิมพ์เลขเอกสารเอง…** to key a code manually).

## Revision history
| Version | Date | Notes |
|---|---|---|
| 1.2 | 2026-07-09 | **Doc-reference dropdowns** — the open-development / view-contract boxes pick from new read-only pending lists `GET /api/realestate/developments` + `GET /api/realestate/contracts` (UI + read-only additions, controls RE-01..04 unchanged). ToE `projects` harness. |
| 1.1 | 2026-07-05 | **Ownership transfer + revenue recognition** (docs/35 P5, RE-04) — authorised, fully-settled-only transfer recognises the sale revenue and relieves the unit cost; unit `cost` field added. Scheduled booking-expiry + overdue-installment jobs. |
| 1.0 | 2026-07-05 | Initial — real-estate developer unit-sales (docs/35 P4): developments/units + availability grid (RE-01), booking, maker-checker sale contract (RE-02), installments (RE-03). Ownership transfer + a dedicated web workspace are a fast-follow. |
