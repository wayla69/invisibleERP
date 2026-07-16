# 50 — SME Launch-Readiness Roadmap (Tracks A–C)

> **Date:** 2026-07-16 · **Status:** v1.2 — Tracks A + B (B1/B2/B3) DELIVERED · Track C = standing checklist ·
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

### B2 — Self-service escape hatch + e2e proof ✅ DELIVERED (this PR)

The industry fold is a *default, not a cage* — and it is now provably right in a real browser.

- **"แสดงเมนูที่ซ่อนไว้" toggle** in the sidebar footer (rendered only for SME tenants with a non-empty
  hidden set, beside "แสดงเมนูขั้นสูง"): reveals the industry-hidden domains, persisted like the advanced
  toggle under the reserved `navFold` key `__show_sme_hidden__` (syncs across devices via user-prefs) —
  an owner who grows into โครงการ doesn't need the platform owner. No API change (the hidden list already
  rides `/me`; the toggle only changes client-side filtering). i18n key `nav.show_sme_hidden` (5 locales).
- **Playwright e2e** `apps/web/e2e/sme-nav-folding.spec.ts` (4 specs, route-mocked backend; the SME
  first-run wizard is stubbed closed via `sme_wizard_done`): restaurant profile hides โครงการ and folds
  kept domains/subgroups (user toggles still work); the POS workspace opens ขายหน้าร้าน with the frontline
  + dining items visible and กะ & ควบคุม folded; the reveal toggle shows/re-hides the hidden domain; an
  enterprise admin sees no toggle and keeps pre-B1 subgroup defaults. Verified locally (17/17 with the
  `workspace-split` regression suite) + web build/typecheck/ratchets green.

### B3 — Industry-aware first-run content ✅ DELIVERED (this PR)

The ~15 visible items land on non-empty screens: `POST /api/tenant/starter-pack` (the wizard's *Create HQ*
button; same create/skip idempotent contract, permission `users` unchanged) now applies an **SME industry
kit** after the HQ branch — restaurant: a sample menu category + 2 items and 4 dining tables; retail: a
sample POS catalog (2 retail items); distribution: a `WH1` warehouse branch; services: a demo project.
Logic lives in the new `modules/billing/starter-pack.service.ts` (the controller is a thin delegate);
each piece seeds only when its table is empty for the tenant. **Design constraint honoured:** everything
seeded is tenant-scoped (`menu_*`, `dining_tables`, `branches`, `projects`) — the SHARED `items` master
(no `tenant_id`) is deliberately never touched, so demo rows can't leak across companies; the harness
asserts this. Enterprise companies keep the exact pre-B3 behaviour (HQ only). `general` SMEs get no kit.
No new control (tenant-scoped sample data under the operator's own duties; MDM maker-checker untouched).
ToE: `onboarding` harness +5 (145 total); UAT-ADM-170.

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
| 1.2 | 2026-07-16 | ERP/Product | **B3 delivered** — SME industry starter kit in `POST /api/tenant/starter-pack` (new `starter-pack.service.ts`; controller delegates): restaurant menu+tables / retail catalog / distribution WH1 branch / services demo project; idempotent create/skip, tenant-scoped only (shared `items` master untouched — harness-asserted), enterprise + `general` unchanged. Onboarding harness 140→145; UAT-ADM-170 + matrix v7.36; manual 00-getting-started v0.3. Track B complete. |
| 1.1 | 2026-07-16 | ERP/Product | **B2 delivered** — "แสดงเมนูที่ซ่อนไว้" self-service reveal toggle (SME-only sidebar footer, reserved synced navFold key `__show_sme_hidden__`, i18n ×5, no API change) + Playwright proof `e2e/sme-nav-folding.spec.ts` (4 specs: hidden domain gone, industry groups open/others folded incl. subgroup defaults, reveal round-trip, enterprise regression; 17/17 with workspace-split). Manual 00-getting-started v0.2. |
| 1.0 | 2026-07-16 | ERP/Product | Re-created after the working-tree reset (see note). Track A recorded delivered (P1–P4, PRs #797/#798/#799). **B1 delivered** — industry-aware SME nav folding at provisioning (shared `nav-profiles.ts`, `sme_prefs` stamp, `/me` `sme_open_nav_groups`, AppShell fold defaults; onboarding +5, `nav-profiles.test.ts` 6; UAT-ADM-169). B2 (reveal toggle + e2e) and B3 (industry starter kit) planned. |
