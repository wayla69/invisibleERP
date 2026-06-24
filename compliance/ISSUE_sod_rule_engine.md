# feat(security): Segregation of Duties — sub-permissions, preventive blocks & detective conflict report

> Ready-to-file engineering issue. File with:
> `gh issue create --title "feat(security): Segregation of Duties — sub-permissions, preventive blocks & detective conflict report" --body-file compliance/ISSUE_sod_rule_engine.md`
> (strip these two quote lines first, or leave them — harmless).

## Why
Our SoD analysis (computed from `packages/shared/src/permissions.ts` → `DEFAULT_ROLE_PERMISSIONS`) found **18 role-level SoD conflicts** plus **2 design-level conflicts inside single permissions**. This is RCM control **ITGC-AC-09** and a top item the IT auditor will test for the NASDAQ/EGC ICFR program. Deliverables: `compliance/Oshinei_ERP_SoD_Matrix_v1.xlsx` (+ generator `compliance/build_sod.py`).

### Current conflicts
- **Sales (7):** `exec`+`approvals` (post & close/certify), `pos` bundles sell+refund+till, `pricelist`/`promos`+`pos`, `crm`+`pos`, `returns`+`pos`.
- **Procurement (4):** `masterdata`+`creditors` (create vendor & pay), `procurement`+`creditors`.
- **Planner (6):** `procurement`+`warehouse` (order & receive), `exec`+`approvals`, `masterdata`+`procurement`.
- **Warehouse (1):** `warehouse` bundles adjust+custody+count.
- **Admin:** inherent superuser (expected; compensating controls).

## Scope

### 1. Split coarse permissions into single-duty sub-permissions
- `pos` → `pos_sell`, `pos_refund`, `pos_till`
- `warehouse` → `wh_receive`, `wh_adjust`, `wh_count`, `wh_custody`
- `exec` → `gl_post`, `gl_close`, `recon_prep`, `fin_report`
- `masterdata` → `md_vendor`, `md_item`, `md_config`
- Update `PERMISSIONS`/`DEFAULT_ROLE_PERMISSIONS` + add a backward-compat alias map (old perm → new set) so existing tokens keep working during migration.

### 2. Re-map `@Permissions` on affected controllers
- `payments.controller` (refund/void/till → `pos_refund`/`pos_till`), `pos.controller`, `wms` controllers, `ledger.controller` (`gl_post` vs `gl_close`), `reconciliation.controller` (`recon_prep` vs `approvals` certify), masterdata/vendor controllers.

### 3. Adopt the remediated role design
- 18 single-duty roles per the **"Proposed Roles"** tab (Cashier, POS Supervisor, AR/AP Clerk, Buyer, Warehouse Operator, Inventory Controller, Stock Counter, GL Accountant, Financial Controller, Master Data Admin, Pricing Manager, CRM/Credit Manager, Returns Clerk, Access Administrator, Executive-read, Customer, Superuser). The "Remediated Matrix" tab shows this design → **0 residual conflicts** (Admin inherent).

### 4. SoD conflict rule registry + detective report
- Encode the 16 rules (Duty A perms × Duty B perms) as a config in `@ierp/shared`.
- `GET /api/admin/sod/conflicts` (Admin-only): returns each **user** holding both sides of any rule, including effective permissions (must resolve per-user `userOverride`, not just role) — feeds the quarterly User Access Review (ITGC-AC-08).

### 5. Preventive guard (admin-users)
- When assigning permissions/overrides to a user, **block or require explicit override-with-justification** if the resulting set violates a SoD rule; log the decision.

## Acceptance criteria
- [ ] Sub-permissions added; alias map keeps existing flows green (typecheck + tests pass).
- [ ] `@Permissions` re-mapped; refund/void/till require the new sub-perms.
- [ ] SoD rule registry in `@ierp/shared` with unit tests asserting the to-be roles yield **0 conflicts** and the as-is roles yield the documented 18.
- [ ] `GET /api/admin/sod/conflicts` returns user-level conflicts (resolves overrides).
- [ ] Preventive block (or justified-override + audit log) on conflicting permission assignment.
- [ ] `/sod` web page renders the live conflict report.

## Notes
- SoD is ultimately **per-user**: the report must evaluate effective permissions after `resolvePermissions(role, userOverride)`.
- `@Permissions` is OR-semantics — keep that in mind when reasoning about effective access.
- Ref: RCM controls ITGC-AC-09, GL-05 (JE maker-checker), EXP-03, INV-04.
