# 15 — UI/UX & Menu Restructure Plan (Navigation IA)

> **Date:** 2026-06-25 · **Status:** DRAFT v0.2 (Phase 0 audit complete) · **Owner:** Web / Product
> **Scope:** Plan a conservative, **URL-stable** restructure of the internal navigation
> (`apps/web/src/lib/nav.ts`, rendered by `apps/web/src/components/app-shell.tsx`) so the menu matches the
> real, grown app structure after the recent ERP + POS feature additions. **This document is a plan only —
> no application code changes are made by it.**
> **Decision recorded:** *Conservative* aggressiveness — regroup, sub-section, and rename labels **without
> changing any `href`/route**, so bookmarks, the ⌘K command palette, and route references in `docs/` keep
> working.

---

## 0. Read this first — the problem in one paragraph

The shell is fine; the **information architecture (IA)** has outgrown its two-level model. `nav.ts` now
drives **~85 visible items in the ERP surface and ~50 in POS**, presented as flat scroll-lists per group.
The workspace switcher (ERP/POS), permission + module filtering, and ⌘K palette in `app-shell.tsx` are all
good and are **kept as-is**. What hurts daily users is: a few groups are enormous flat lists, two groups
collide by name across the switcher, and "ระบบ (System)" has become a catch-all. The fix is a **taxonomy
migration plus an optional third nesting level**, not a visual rebuild and not a route change.

---

## 1. Current state (baseline, from `nav.ts`)

Single source of truth: `INTERNAL_NAV: NavGroup[]` (group → items, two levels only). Items/groups carry
`workspace: ('erp'|'pos')[]` tags; `BOTH` cross-lists an item into both surfaces. `navForWorkspace()`
filters by workspace; `app-shell.tsx` then filters by permission (`hasPerm`) and disabled modules.

| Group (current `title`) | Workspace | Item count | Pain |
|---|---|---:|---|
| ภาพรวม (Overview) | both (split) | 2 | ok |
| การขาย (Sales) | pos | ~22 | **flat mega-list**: POS, tables, KDS, menu, buffet, food cost, analytics, production, claims, delivery, POS control, print, peripherals, pricing, channels, POS ops, card terminals, house accounts, branches |
| ลูกค้า & การขาย (Customers & Sales) | erp | 13 | name collides with POS "การขาย"; mixes CRM/CPQ/service with all 8 loyalty sub-pages |
| สต๊อก & จัดซื้อ (Stock & Procurement) | erp | 19 | **flat**: inventory+warehouse+procurement+manufacturing all in one group |
| การเงิน (Finance) | erp | 9 | ok-ish |
| บุคลากร & เงินเดือน (People & Payroll) | erp | 2 | ok |
| ภาษี (Tax) | erp | 4 | ok |
| วางแผน & วิเคราะห์ (Planning & Analytics) | erp | 7 | ok |
| การควบคุม (Controls) | both | 5 | ok |
| ผู้ช่วย AI (AI) | both | 3 | ok |
| ระบบ (System) | both | **24** | **catch-all dumping ground**: master data, custom fields/objects/layouts, alerts, automation, AI-config, saved views, dashboards, doc templates, theme, onboarding, developer, connectors, migration, localization, e-invoicing, webhooks, users, setup, billing, settings |

**Diagnosis**

1. **Only two levels.** `NavGroup → NavItem` has no sub-sectioning or per-section collapse, so a 24-item
   group is a 24-row scroll.
2. **Name collision.** ERP "ลูกค้า & การขาย" vs POS "การขาย" — overlapping mental models across the switcher.
3. **"ระบบ" is overloaded** — four unrelated concerns (master data / customization / integration /
   administration) in one bucket.
4. **No favorites / recents / pinning** despite ~85 destinations — high navigation cost for daily operators.
5. **Big flat operational groups** ("สต๊อก & จัดซื้อ" 19, POS "การขาย" 22) bury frequently-used items.

**What is explicitly kept (do not touch):** every `href`; the ERP/POS switcher; `workspace`/`BOTH`
cross-listing; permission + module filtering; the ⌘K palette flattening all items.

---

## 2. Target information architecture (conservative)

Principle: **same destinations, better shelves.** Re-bucket existing items into clearer top-level groups,
and break the biggest groups into **collapsible sub-sections** (a new optional third level). Labels may be
renamed for clarity; **no `href` changes**.

### 2.1 ERP surface — proposed top-level groups

```
ภาพรวม (Overview)            → แดชบอร์ด
ลูกค้า & การขาย (CRM/Sell)    → โอกาสการขาย · ใบเสนอราคา · บริการ & SLA · CRM 360 · การตลาด   ← (loyalty moves out)
ลอยัลตี้ (Loyalty)            → สมาชิก & แต้ม · ของรางวัล · ภารกิจ · วงล้อ · แคมเปญ · พันธมิตร · วิเคราะห์
สินค้าคงคลัง (Inventory)      ▸ สต๊อก: สินค้าคงคลัง · ตรวจนับ · เบิก/โอน · ล็อต/อายุ · สแกนมือถือ · รูปภาพ · WMS · ต้นทุน · เติมสต๊อก
จัดซื้อ (Procurement)         → ซัพพลายเออร์ · ใบสั่งซื้อ · จัดซื้อจัดจ้าง · RFQ · จับคู่ 3 ทาง · Document AI
การผลิต (Manufacturing)       → BoM · ใบสั่งผลิต · การผลิตขั้นสูง (Routing/QA/MRP)
การเงิน (Finance)            → การเงิน · บัญชีแยกประเภท · สินทรัพย์ · ธนาคาร · กระทบยอด · รับรู้รายได้ · ระหว่างบริษัท · งบรวม · FX
ภาษี (Tax)                   → ใบกำกับ · รายงาน · หัก ณ ที่จ่าย · e-Tax (BOTH)
บุคลากร (People)             → HR · Payroll
วางแผน & BI (Planning & BI)  → งบประมาณ · โครงการ · กำไรตามมิติ · BI · Studio · NL Analytics · Scheduled reports
การควบคุม (Controls)          → อนุมัติ · SoD · Audit trail · Controls · Ops   (BOTH)
ผู้ช่วย AI (AI)               → Assistant · AI Actions · Copilot   (BOTH)
ตั้งค่าระบบ (Settings)        ▸ ข้อมูลหลัก: master-data · custom-fields · custom-objects · object-layouts · saved-views
                              ▸ ปรับแต่ง: alerts · automation · ai-config · dashboard-designer · document-templates · theme
                              ▸ เชื่อมต่อ: connectors · webhooks · developer · migration · localization · einvoice
                              ▸ ผู้ดูแล: onboarding · admin/users · setup · billing · settings
```

Net effect on the worst groups:
- **"ระบบ" (24) → "ตั้งค่าระบบ" with 4 collapsible sub-sections** (~5–6 items each, collapsed by default).
- **"สต๊อก & จัดซื้อ" (19) → three focused groups** (Inventory / Procurement / Manufacturing).
- **Loyalty (8 items) split out** of "ลูกค้า & การขาย", resolving the CRM/loyalty overload.

### 2.2 POS surface — proposed top-level groups

```
ภาพรวม (Overview)        → ภาพรวมหน้าร้าน (/pos-home)
ขาย (Sell)               → POS · โต๊ะ · เมนูอาหาร · บุฟเฟต์ · ควบคุม POS · ใบเสร็จ & งานพิมพ์
ครัว (Kitchen)           → ครัว (KDS)
ร้าน & การจัดส่ง (Store & Delivery) → จัดการเคลม · ใบส่งสินค้า · ช่องทางเดลิเวอรี · สาขา (BOTH)
อุปกรณ์ (Hardware)        → อุปกรณ์ฮาร์ดแวร์ · เครื่องรับบัตร & สรุปยอด
ราคา & โปรโมชั่น (Pricing) → กฎราคา & โปรโมชั่น (BOTH)
ลอยัลตี้ (Loyalty)        → POS Ops · สมาชิก & แต้ม · ของรางวัล … (cross-listed BOTH items)
การเงินหน้าร้าน          → มัดจำ & บัญชีเครดิต · e-Tax/Journal (BOTH)
วิเคราะห์ (Analytics)     → ต้นทุนอาหาร · วิเคราะห์ร้านอาหาร · แผนการผลิต
การควบคุม / ผู้ช่วย AI / ตั้งค่า → (shared BOTH groups, same as ERP)
```

This turns the 22-item POS "การขาย" into ~6 task-focused groups that mirror a store shift (sell → kitchen →
store/delivery → hardware → pricing → loyalty → money → analytics).

> The exact Thai labels and the precise sub-section boundaries are the **sign-off artifact of Phase 1** —
> §2 is the proposed default, to be confirmed before any `nav.ts` edit.

---

## 3. Data-model change required (Phase 2, for reference only)

To support collapsible sub-sections without breaking the existing flat groups, extend the nav types
additively (an absent `children` keeps today's behavior):

```ts
export interface NavSubGroup {
  title: string;                 // sub-section header (collapsible)
  items: NavItem[];
  defaultOpen?: boolean;         // collapsed by default for long Settings sub-sections
  workspace?: Workspace[];
}
export interface NavGroup {
  title: string;
  items?: NavItem[];             // existing flat items (unchanged)
  subgroups?: NavSubGroup[];     // NEW optional third level
  workspace?: Workspace[];
}
```

`navForWorkspace()` recurses into `subgroups`; the ⌘K palette continues to **flatten all levels** so search
still reaches everything. `app-shell.tsx` renders `subgroups` with the existing `Sidebar` collapsible
primitive. **Favorites/Recents** is a separate localStorage-backed pseudo-group pinned at the top
(out of scope for this plan doc; listed in Phase 2).

---

## 4. Phased delivery (this doc covers Phase 1 sign-off)

| Phase | Outcome | Code? | Docs? |
|---|---|---|---|
| **0 — Audit** ✅ | **DONE (2026-06-25).** Diffed `nav.ts` hrefs vs routes: 0 dead links, 3 unlinked pages (2 intentional, 1 genuine orphan `/loyalty`). See §4a. | none (script only) | this file |
| **1 — IA sign-off** | Confirm §2 taxonomy, final Thai labels, sub-section boundaries. **(this document)** | none | this file |
| **2 — Model + shell** | Add `subgroups` to nav types; recurse in `navForWorkspace`; render collapsible sub-sections; add Favorites/Recents. | `nav.ts`, `app-shell.tsx`, `sidebar` usage | — |
| **3 — Migrate nav** | Re-bucket items into §2 groups/sub-sections; rename labels. **No `href` changes.** | `nav.ts` | — |
| **4 — Docs sync** | Per CLAUDE.md: update screen/route/nav references in process narratives, user-manual route+role tables, and UAT nav cases + traceability. | — | `docs/process-narratives/`, `docs/user-manual/`, `docs/uat/` |
| **5 — QA** | Extend Playwright e2e (switcher + nested nav + permission filtering); `pnpm -r typecheck`; `pnpm --filter @ierp/web build`. | tests | — |

---

## 4a. Phase 0 audit results (run 2026-06-25)

Method: extracted every `href` from `INTERNAL_NAV` in `nav.ts` (excluding the customer `/portal/*` surface)
and diffed against every `app/(internal)/**/page.tsx` route on disk.

**Headline numbers**

| Metric | Value |
|---|---:|
| Unique nav `href`s (internal) | 103 |
| Internal `page.tsx` files | 108 |
| — static routes | 106 |
| — dynamic detail routes (`[id]`/`[itemId]`) | 2 |
| **Orphan nav entries** (href in nav, no page on disk → dead links) | **0** |
| **Unlinked pages** (route on disk, not in `INTERNAL_NAV`) | **3** |

**Finding 1 — zero dead links.** All 103 nav `href`s resolve to a real page. This confirms the migration
can be done **URL-stable with no broken sidebar links** — the conservative plan's core assumption holds.

**Finding 2 — three unlinked pages, classified:**

| Route | Reached via | Verdict |
|---|---|---|
| `/notifications` | Header notification bell (`notification-bell.tsx` → `href="/notifications"`) | **Intentional** — not a sidebar destination. Leave out of nav. |
| `/pos/new` | In-POS "new order" flow (`pos/page.tsx` → `<Link href="/pos/new">`) | **Intentional** — sub-route of `/pos`. Leave out of nav. |
| `/loyalty` | **Nothing internal** — the only `/loyalty` reference is the *customer-portal* `/portal/loyalty`. The internal loyalty **config/settings** page has no link anywhere. | **Genuine orphan** — unreachable except by typing the URL. **Action: add to the new "ลอยัลตี้ (Loyalty)" group in Phase 3** (e.g. "ตั้งค่าลอยัลตี้ / Loyalty settings"). |

**Finding 3 — cross-listing is by tag, not duplication.** `BOTH`-workspace items (e.g. `/pricing`,
`/branches`, the loyalty pages) appear **once** in the `nav.ts` source with `workspace: BOTH` and are
cross-listed at render time by `navForWorkspace()`. Zero duplicate `href`s in source → the Phase 3
re-bucketing cannot accidentally double-list an item.

**Audit conclusion.** The nav is a clean, link-complete baseline. The regrouping is purely a *shelving*
exercise; the only **content** change surfaced is wiring the orphaned `/loyalty` config page into the new
Loyalty group. Audit script archived at `scratchpad/audit2.mjs` (re-runnable; not committed).

---

## 5. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Broken bookmarks / deep links | **No `href` changes** (conservative decision). Routes are frozen; only grouping/labels move. |
| ⌘K palette misses items under sub-sections | Palette keeps flattening **all** levels (`paletteGroups` already maps the full `nav`). |
| Docs drift (SOX/ICFR deliverable) | Phase 4 is mandatory and gated by CLAUDE.md doc-sync policy; revision histories bumped. |
| Permission/module filtering regressions | Filtering logic in `app-shell.tsx` is unchanged; extend it to recurse and add an e2e assertion (Phase 5). |
| Collapsible state churn | Long Settings sub-sections `defaultOpen: false`; persist open/closed per group in localStorage. |
| Label-only renames confuse muscle memory | Keep icons + hrefs stable; rename conservatively; announce in onboarding/release notes. |

---

## 6. Recommendation

Proceed with the **conservative IA migration** in §2. It removes the three real pain points (24-item System
catch-all, 19/22-item flat operational groups, CRM/Loyalty overload and the name collision) with **zero
route changes** and a small, additive data-model extension. Next actionable step on approval of §2:
**Phase 0 audit**, then **Phase 2** (nav types + shell), then **Phase 3** migration with the **Phase 4**
doc sync committed in the same series.

---

## Revision history

| Date | Version | Author | Change |
|---|---|---|---|
| 2026-06-25 | v0.1 (DRAFT) | Web / Product | Initial plan: conservative, URL-stable navigation IA restructure for ERP + POS; proposed target taxonomy, additive `subgroups` model, 6-phase delivery, risk register. No application code changed. |
| 2026-06-25 | v0.2 (DRAFT) | Web / Product | Phase 0 audit executed and recorded (§4a): 103 nav hrefs, 0 dead links, 3 unlinked pages classified (`/notifications` + `/pos/new` intentional; `/loyalty` config page is a genuine orphan to wire into the new Loyalty group in Phase 3). Cross-listing confirmed tag-based, not duplicated. No application code changed. |
