# Sales Kit (internal sales enablement)

`sales-kit.pdf` (22 pages, A4) is the field guide for selling Invisible ERP,
rendered from the self-contained `sales-kit.html` (same white/pastel design
rule as the pitch deck — see `docs/pitch-deck/README.md`).

Contents:

1. How to use this kit
2. Elevator pitches (10s / 30s / 2min) + positioning statement
3. Product at a glance — architecture + integration surface
4. Module catalog in detail (front of house, supply chain, finance, people/platform)
5. Ideal customer profile & 4 buyer personas with talk tracks
6. Value map — pain → capability → demo proof point
7. Competitive battlecards (legacy ERP suites, POS point solutions, spreadsheets)
8. Objection handling (8 objections with responses)
9. Pricing & packaging guidance (illustrative — confirm with sales ops)
10. Discovery question bank + qualify-out criteria
11. The 15-minute golden-path demo script
12. ROI levers with example math (illustrative)
13. Implementation journey (5 phases, weeks 1–12+)
14. Security & compliance fact sheet (hand to the customer's reviewer as-is)
15. FAQ
16. Back cover / CTA

## Thai version (ฉบับภาษาไทย)

`sales-kit-th.pdf` (23 pages, A4) is the full Thai translation, rendered from
`sales-kit-th.html` with the Sarabun typeface embedded (self-contained file).

## ✍️ Tone rule (standing instruction)

Per the product owner: all customer- and internal-facing documents must read as
**formal business writing** (ภาษาธุรกิจทางการ) — natural professional prose, no
casual particles, no gimmicky metaphors, no machine-translation phrasing. This
applies alongside the white/pastel visual rule in `docs/pitch-deck/README.md`.

Pricing figures and ROI math are illustrative placeholders — replace with the
current price list before customer-facing use. To regenerate the PDF after
editing the HTML: print `sales-kit.html` to PDF with headless Chromium (A4).

> Sales asset only — not imported by `apps/web` or `apps/api`; no effect on
> application behavior, builds, or CI gates.
