# Investor Pitch Deck (interactive, web-based)

`PitchDeck.jsx` is a self-contained, single-file React component that renders an
interactive 7-slide investor presentation for Invisible ERP:

1. Title — Next-Gen Enterprise ERP
2. The Problem — legacy ERPs: bulky, slow, weak controls, brittle integrations
3. The Solution — lean ~260k-LOC TypeScript architecture, QR-order → GL data flow
4. Security & Compliance — SOX-ICFR, fail-closed RLS, 24 roles / 82 permissions / 26 SoD rules
5. Omnichannel & Integrations — untrusted webhook boundary vs. trusted API tier
6. Traction & QA — golden zero-diff parity, CI/CD ratchets, SSO/SCIM
7. Closing — ready for scale, ready for audit

## Usage

The component has no props and no external assets — it needs only **React**,
**Tailwind CSS**, and **lucide-react**:

- **Claude Artifacts:** paste the file contents into a React artifact as-is
  (default export, Tailwind classes, `lucide-react` imports are all supported).
- **Any React app:** drop the file in and render `<PitchDeck />` anywhere
  Tailwind is active.

Navigation: **Next / Prev** buttons, clickable progress dots, and the
**← / →** arrow keys.

> Presentation asset only — this directory is not imported by `apps/web` or
> `apps/api` and has no effect on application behavior, builds, or CI gates.
