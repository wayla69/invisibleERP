# Investor Pitch Deck (interactive, web-based)

`PitchDeck.jsx` is a self-contained, single-file React component that renders an
interactive 16-slide investor presentation for Invisible ERP:

1. Title — Next-Gen Enterprise ERP
2. The Problem — legacy ERPs: bulky, slow, weak controls, brittle integrations
3. The Solution — lean ~260k-LOC TypeScript architecture, QR-order → GL data flow
4. Product Tour — one platform, every business cycle (POS → BI)
5. Security & Compliance — SOX-ICFR, fail-closed RLS, 24 roles / 82 permissions / 26 SoD rules
6. Omnichannel & Integrations — untrusted webhook boundary vs. trusted API tier
7. Market Opportunity — Thai F&B mid-market, compliance tailwind, SEA path
8. Business Model — per-company SaaS, AI usage metering, land-and-expand
9. Traction & QA — golden zero-diff parity, CI/CD ratchets, SSO/SCIM
10. Why We Win — comparison vs. legacy ERP suites and POS point solutions
11. Roadmap — delivered → IPO readiness → regional scale → AI-native ops
12. Project Cost — ฿60M+ replacement-cost breakdown of the built platform
13. Use of Funds — ฿70M seed allocation, burn, and 18–20-month runway
14. Seed Round — The Ask — ฿70M at ฿280M pre-money (~20% post) + Series A milestones
15. Valuation Model — replacement-cost floor, seed comparables, forward-multiple
    method with an ARR × multiple sensitivity table
16. Closing — ready for scale, ready for audit

> All seed-stage financial figures (slides 12–15) are an illustrative financing
> model for discussion, not an offer of securities.

## 🎨 Design rule (มาตรฐานสไลด์ — ใช้กับทุกสไลด์ ทุกครั้ง)

Per the product owner's standing instruction, **every slide deck in this project
must use**:

- **พื้นหลังสีขาว** — white background (no dark themes)
- **โทนสีพาสเทล** — pastel accent tones (blue-50/100, emerald-50/100, violet,
  amber, rose, sky) for chips, badges, stats, and zone fills
- **ตัวอักษรชัด อ่านง่าย** — dark, highly readable text (slate-900 headings,
  slate-600/700 body); pastel is for backgrounds and accents only, never for
  body text

Apply this rule to any future slide, deck revision, or export format.

## Usage

The component has no props and no external assets — it needs only **React**,
**Tailwind CSS**, and **lucide-react**:

- **Claude Artifacts:** paste the file contents into a React artifact as-is
  (default export, Tailwind classes, `lucide-react` imports are all supported).
- **Any React app:** drop the file in and render `<PitchDeck />` anywhere
  Tailwind is active.

Navigation: **Next / Prev** buttons, clickable progress dots, and the
**← / →** arrow keys.

## PDF export

- `pitch-deck.pdf` — 12-page 16:9 landscape export (960×540 pt per page).
- `pitch-deck.html` — the print-optimized standalone source it was rendered
  from (all CSS and Lucide SVGs inlined). Open in any browser, or re-print to
  PDF with headless Chromium after edits.

> Presentation assets only — this directory is not imported by `apps/web` or
> `apps/api` and has no effect on application behavior, builds, or CI gates.
