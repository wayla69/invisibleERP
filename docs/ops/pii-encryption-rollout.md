# PII-at-rest encryption — rollout (panel Round-2, condition #2)

> **Status: mechanism SHIPPED; phased field rollout IN PROGRESS.**
> The reusable primitive and the first safe fields are merged; `loyalty_members`/`customer_master`
> phone+email are now encrypted with exact-match blind-index lookup (0284); the remaining lookup-keyed
> fields are scaffolded below with exact steps and deferred so nothing else breaks mid-rollout.

## What shipped

- **`encryptedText` Drizzle column type** + **`blindIndex()`** helper — `apps/api/src/database/encrypted-column.ts`.
  Transparent AES-256-GCM encrypt-on-write / decrypt-on-read over `common/crypto.ts` (`v1:…`, legacy-plaintext
  passthrough → **no backfill required** to start; new writes encrypt, old plaintext still reads).
- **Applied (safe — not queried by value):** `customer_master.tax_id` (Thai tax/national ID),
  `customer_master.notes`. No DDL needed (column stays `text`, now holds ciphertext); existing rows read via
  passthrough.
- **Applied 2026-07-02 (docs/27 R0-1 — investment-audit finding AUD-LGL-01):**
  `employees.national_id` / `sso_no` / `bank_account`, `payslips.national_id` (per-slip snapshot),
  `vendors.tax_id` / `bank_account`. Two value-keyed SQL aggregations were rewritten to group **decrypted**
  values in app code (random-IV ciphertext never collides): ภ.ง.ด.1ก per-employee summary
  (`payroll.service.ts pnd1a`, now keyed on `employee_id`) and the ghost-vendor duplicate-tax-ID detector
  (`controls.service.ts scan`). At-rest ToE lives in the `hcm` + `ext` harnesses.
- **Backfill shipped:** `pnpm --filter @ierp/api db:backfill:pii` (`database/backfill-encrypt-pii.ts`) —
  idempotent (`not like 'v1:%'` discriminator), re-writes every legacy plaintext row through the column type
  for ALL encrypted columns above (including the customer_master ones that predate it). Also runs a
  blind-index backfill pass (`BIDX_TARGETS`) that populates any row's `phone_bidx`/`email_bidx` still NULL,
  reading through Drizzle so it works whether the row is already ciphertext or still legacy plaintext. Run
  once per environment after deploy; requires the same `APP_ENC_KEY` as the API.
- **Unit test:** `apps/api/test/pii-encrypt.test.ts` (round-trip, fresh-IV, plaintext passthrough, blind-index
  determinism/normalization).
- **Applied 2026-07-08 (migration 0284):** `pos_members.phone`/`email` and `customer_master.phone`/`email`
  encrypted, each with a companion `<col>_bidx` (blindIndex()) column for exact-match lookup. Decision on the
  substring-search tradeoff (item 3 of the table below): **(a) downgrade to exact-match** — substring/partial
  phone or email search is retired everywhere (loyalty member search, customer search, global ⌘K search);
  name/card_no/member_code/customer_no substring search is unaffected. Rewritten call sites: member OTP login
  (`member-auth.service.ts`), member lookup/P2P-transfer/enroll/update (`member.service.ts`), referral-by-phone
  (`referrals.service.ts`), coalition cross-shop resolve (`coalition.service.ts`), customer create/update/
  list/merge (`customers.module.ts`), lead-to-customer conversion (`crm-pipeline.service.ts`), and both search
  entities in `search.module.ts`. PDPA erasure (`pdpa.service.ts redactMember`) now also nulls the `_bidx`
  companions. The old plaintext partial-unique index `pos_members_tenant_phone` is replaced by a unique index
  on `(tenant_id, phone_bidx)` (ciphertext's random IV can no longer enforce "one phone per tenant" itself).
  At-rest ToE: extend `pg-smoke`/`ext` per the checklist below before the next full harness run.

## Why the rest is phased (not a rushed big-bang)

`encryptedText` makes a column **unsearchable by SQL** (equality/`ilike` would match ciphertext). The
remaining PII columns are either **lookup keys** or **substring-searched**, so each needs a companion
**blind-index** column AND its query rewritten — encrypting them blindly would break login/search in prod:

| Table.column | Current use | Required rewire |
|---|---|---|
| ~~`loyalty_members.phone` / `email`~~ | ~~lookup key (member login/dedupe) / messaging~~ | **DONE 2026-07-08** — `phone_bidx`/`email_bidx` added (0284), every lookup rewired to filter on bidx |
| ~~`customer_master.email` / `phone`~~ | ~~`ilike` substring search~~ | **DONE 2026-07-08** — decision (a): downgraded to exact-match bidx (0284); substring search on phone/email retired |
| `crm_pipeline.email` / `phone` | display (leads) | safe to encrypt if not searched — verify, then apply `encryptedText` |
| `loyalty_referrals.referred_phone` | display | likely safe — verify, then apply |
| ~~`hcm` employee identifiers~~ | ~~varies~~ | **DONE 2026-07-02** — `employees.national_id`/`sso_no`/`bank_account` + `payslips.national_id` encrypted; PND1A grouped in app code |
| ~~`vendors.tax_id` / `bank_account`~~ | ~~ghost-vendor GROUP BY~~ | **DONE 2026-07-02** — encrypted; detector groups decrypted values in app code |
| `wht_certificates.payee_tax_id` (+ payer) | statutory filing snapshot (display/PDF) | verify no value-based query, then apply `encryptedText` (next phase) |

## Rollout checklist (per table)

1. Grep every value-based filter on the column (`eq(...col...)`, `ilike(...col...)`).
2. If only **exact match**: add `<col>_bidx text` (migration, NEXT FREE number + journal + RLS loop already
   covers the table), write `blindIndex(value)` on insert/update, rewrite the lookup to filter `<col>_bidx`,
   then switch the column to `encryptedText`.
3. If **substring search**: decide (a) downgrade to exact-match bidx, or (b) leave plaintext — record the
   decision here.
4. Backfill existing rows: a one-off script that reads each row via the base connection, sets the encrypted
   value + bidx (the app key is required — cannot be done in pure SQL).
5. Verify on real Postgres (`pnpm --filter @ierp/cutover pg-smoke` extended with a ciphertext-at-rest assert):
   raw SQL shows `v1:…`, schema read decrypts, bidx lookup + login still work, DSAR export returns plaintext,
   AI `redactPii` still masks.

## Revision history

| Date | Version | Change |
|------|---------|--------|
| 2026-06-30 | v0.1 | Mechanism + `customer_master.tax_id`/`notes` shipped; lookup-keyed fields scaffolded + deferred. |
| 2026-07-02 | v0.2 | **docs/27 R0-1:** employee (`national_id`/`sso_no`/`bank_account`), payslip (`national_id`) and vendor (`tax_id`/`bank_account`) columns encrypted; PND1A + ghost-vendor aggregations moved to app-code grouping over decrypted values; idempotent `db:backfill:pii` script ships (covers the earlier customer_master debt too); at-rest ToE in `hcm`/`ext`; RCM ITGC-AC-19 text updated + xlsx regenerated. |
| 2026-07-08 | v0.3 | **Migration 0284:** `pos_members`/`customer_master` `phone`/`email` encrypted with companion `_bidx` blind-index columns; decision (a) — substring search on phone/email retired in favour of exact-match (member search, customer search, global search); every lookup/dedupe/DSAR-erasure site rewired to filter on the bidx; `db:backfill:pii` extended with a `BIDX_TARGETS` pass. |
