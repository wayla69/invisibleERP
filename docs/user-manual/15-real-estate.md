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

## Revision history
| Version | Date | Notes |
|---|---|---|
| 1.0 | 2026-07-05 | Initial — real-estate developer unit-sales (docs/35 P4): developments/units + availability grid (RE-01), booking, maker-checker sale contract (RE-02), installments (RE-03). Ownership transfer + a dedicated web workspace are a fast-follow. |
