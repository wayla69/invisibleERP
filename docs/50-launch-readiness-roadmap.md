# 50 — SME Launch-Readiness Roadmap (Tracks A–C)

> **Date:** 2026-07-16 · **Status:** v1.0 — Track A DELIVERED · Track B: B1 DELIVERED, B2/B3 planned ·
> **Owner:** ERP / Product
> **Scope:** The last mile between "the SME single-user edition exists" (`docs/49`, fully delivered
> v1.0–1.6) and "a solo Thai business owner can be handed a login and succeed on day one." Three tracks:
> **A** — security launch gate (pentest remediation), **B** — launch UX (make the first session feel like
> a product built for *their* business, not a 210-item enterprise console), **C** — go-live operations.
> Same delivery discipline as docs/19/23/49: each item an independently-shippable, doc-synced PR, merged
> only on a fully green CI matrix.
>
> **Note:** this document is a re-creation. The original docs/50 draft (authored alongside B1) was lost to
> a working-tree reset before it was committed; B1 itself was re-implemented and re-verified from the
> handoff brief. Track B item scopes below are the re-confirmed plan of record.

---

## Track A — Security launch gate ✅ DELIVERED

White-box pentest (2026-07-16, `docs/security/2026-07-16-penetration-test-report.md`) found four findings;
all remediated and merged before this roadmap's Track B work:

| # | Finding | Fix | PR |
|---|---|---|---|
| P1 | Password reset could seize a peer Admin account | reset authorizes on the TARGET's role (`ADMIN_GRANT_DENIED`) | #797 |
| P2 | SSO JIT `default_role` could mint an Admin | privileged roles excluded (`BAD_ROLE` / fail-closed `SSO_ROLE_NOT_ALLOWED`) | #797 |
| P3 | Platform-owner-minted API key acted as god | `PlatformAdminGuard` rejects machine principals (`PLATFORM_ADMIN_REQUIRED`) | #797 |
| P4 | JE approval bypassed the hard-close gate | `PERIOD_LOCKED` re-check on the approval path | #798 |

Handoff brief: #799. UAT-ADM-166..168, UAT-GL-189; PN-27 rev 1.3, PN-04 rev 2.34.

---

## Track B — Launch UX: "the menu fits my business" (210 → ~15)

The docs/49 edition solved *authority* (one operator can legally do every job). Track B solves
*orientation*: the enterprise information architecture (~210 sidebar items across 12 domains) is the #1
first-session drop-off risk for a solo owner. The lever: the system already knows the company's
**industry** (the CoA template chosen at provisioning) — use it.

### B1 — Industry-aware nav folding at provisioning ✅ DELIVERED (this PR)

Fold each `control_profile='sme'` tenant's sidebar from its industry, at provisioning:

- **Shared mapping** `packages/shared/src/nav-profiles.ts`: per-industry profiles
  (restaurant / retail / distribution / services / general) of **hidden** top-level nav domains +
  **default-open** group/subgroup title keys, over a hand-maintained census of
  `apps/web/src/lib/nav.ts` (sync rule documented in both files; unknown keys degrade gracefully).
  `general` (and any unknown industry) hides nothing — the safe fallback.
- **Stamp at provisioning** (`tenant-provisioning.service.ts`): the industry profile's hidden set is
  unioned with the god-configured platform SME defaults and stored with the open list in
  `tenants.sme_prefs` (`hidden_nav_groups`, `open_nav_groups`, `nav_industry`) — a birth attribute, like
  the rest of the stamped copy. The god per-tenant prefs editor (`POST /api/admin/tenants/:id/sme-prefs`)
  keeps owning `hidden_nav_groups` but now **preserves** the stamped open profile.
- **Surface on `/api/auth/me`**: new `sme_open_nav_groups` beside the existing `sme_hidden_nav_groups`
  (both SME-only; enterprise payloads unchanged).
- **Apply in the AppShell**: listed groups/subgroups default OPEN, every other subgroup defaults FOLDED
  (pre-B1 default `defaultOpen ?? true` kept when no profile). A user's own synced `navFold` toggle always
  wins, and the domain/subgroup holding the active route always opens. ⌘K palette + favourites still see
  everything (hidden = sidebar-only).
- **Result:** a restaurant SME's first login shows ~14 items (ภาพรวม + POS ขายหน้าร้าน + โต๊ะ/ครัว);
  a distribution SME ~16 (จัดซื้อ); services ~13 (CRM + โครงการ) — instead of ~210.

No new control, migration, or permission (JSONB prefs + nav chrome only). Verification: shared build →
`apps/api/test/nav-profiles.test.ts` (6 — census consistency, hidden/open disjointness, 8–25 visible-item
band per industry, safe fallback, census drift floor) → api build + `onboarding` harness (140, +5 B1) +
`sme` harness (47, unchanged) → web build + typecheck; all four CI ratchets flat. Docs: manual
11-administration §14 (v0.24), UAT-ADM-169 + matrix v7.35, docs/49 rev 1.7.

### B2 — Self-service escape hatch + e2e proof (next)

The industry fold must be a *default, not a cage* — and it must be provably right in a real browser.

- **"แสดงเมนูที่ซ่อนไว้" toggle** in the sidebar footer (SME tenants with a non-empty hidden set only,
  beside the existing "แสดงเมนูขั้นสูง"): temporarily reveals the industry-hidden domains for the
  session/user, persisted like the advanced toggle under a reserved `navFold` key — so an owner who grows
  into โครงการ doesn't need the platform owner. No API change (the hidden list already rides `/me`;
  the toggle only changes client-side filtering).
- **Playwright e2e** (`apps/web/e2e`): SME login (route-mocked `/api/auth/me` with a restaurant profile) →
  assert hidden domains absent, listed groups open, everything else folded, ⌘K still reaches a hidden
  item, and the reveal toggle works — desktop + `mobile-iphone` projects (no horizontal overflow per the
  repo's mobile recipe).

### B3 — Industry-aware first-run content (after B2)

The ~15 visible items must land on non-empty screens. Extend the SME setup wizard + `starter-pack` with
an industry starter kit applied at first run (owner-confirmed, idempotent, skippable): restaurant — sample
menu categories + a few tables; retail — item categories + a barcode-ready sample item; distribution — a
second warehouse + a sample supplier; services — a sample project with a one-line BoQ. Rides the existing
`POST /api/tenant/starter-pack` create/skip contract; no new control (master-data seeding under the
operator's own duties; MDM maker-checker seams untouched).

---

## Track C — Go-live operations (standing checklist, not a PR series)

Pointers, all existing: deploy smoke (`claude/add-deploy-smoke-test`), tenancy boot checks fail-closed
(H-3/H-4, `docs/ops/tenancy-model.md`), `TENANCY_MODE=multi-company` on every outside-facing deploy
(AC-18), service worker network-first HTML (deploy-safe chunks), LINE OA go-live runbook
(`docs/ops/line-oa-golive.md`), migration journal monotonicity gate. Launch sign-off = Track A merged +
B1 live + this checklist walked for the target environment.

---

## Revision history
| Rev | Date | Author | Change |
|---|---|---|---|
| 1.0 | 2026-07-16 | ERP/Product | Re-created after the working-tree reset (see note). Track A recorded delivered (P1–P4, PRs #797/#798/#799). **B1 delivered** — industry-aware SME nav folding at provisioning (shared `nav-profiles.ts`, `sme_prefs` stamp, `/me` `sme_open_nav_groups`, AppShell fold defaults; onboarding +5, `nav-profiles.test.ts` 6; UAT-ADM-169). B2 (reveal toggle + e2e) and B3 (industry starter kit) planned. |
