import { Inject, Injectable, BadRequestException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { tenantLocalization, tenants } from '../../database/schema';
import type { JwtUser } from '../../common/decorators';

// C2 (Platform Phase 21) — country localization packs (the Odoo l10n model). Each pack (declared in code)
// bundles a CoA preview + tax codes + statutory reports + an e-invoicing provider + locale. Applying a pack
// sets the tenant's tax country + default locale and records the active pack; the CoA/tax content is exposed
// for review — seeding it into the live ledger (with maker-checker) is a guarded follow-up. RLS-scoped; no GL.
const PACKS = [
  { country: 'TH', label: 'Thailand', label_th: 'ไทย', status: 'certified', locale: 'th', einvoice_provider: 'einvoice.th.rd',
    coa_preview: ['1000 เงินสด', '1100 ลูกหนี้การค้า', '2100 เจ้าหนี้การค้า', '2200 ภาษีขาย', '4000 รายได้จากการขาย'],
    tax_codes: ['VAT7', 'VAT0', 'EXEMPT'], statutory_reports: ['ภ.พ.30', 'ภ.ง.ด.53'] },
  { country: 'MY', label: 'Malaysia', label_th: 'มาเลเซีย', status: 'draft', locale: 'ms', einvoice_provider: 'einvoice.my.myinvois',
    coa_preview: ['1000 Cash', '1100 Trade Receivables', '2100 Trade Payables', '4000 Revenue'],
    tax_codes: ['SST', 'ZRL', 'EXEMPT'], statutory_reports: ['SST-02'] },
];
const COUNTRIES = PACKS.map((p) => p.country);

@Injectable()
export class LocalizationService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  packs() { return { packs: PACKS.map((p) => ({ ...p })) }; }

  async get(_user: JwtUser) {
    const [row] = await (this.db as any).select().from(tenantLocalization).limit(1);
    return { active: row ? { country: row.country, version: row.version, applied_at: row.appliedAt } : null };
  }

  async apply(user: JwtUser, country: string) {
    const pack = PACKS.find((p) => p.country === country);
    if (!pack) throw new BadRequestException({ code: 'BAD_COUNTRY', message: `country must be one of ${COUNTRIES.join(', ')}`, messageTh: 'ยังไม่รองรับประเทศนี้' });
    const db = this.db;
    if (user.tenantId != null) await db.update(tenants).set({ taxCountry: country, defaultLanguage: pack.locale }).where(eq(tenants.id, user.tenantId));
    const [exists] = await db.select({ id: tenantLocalization.id }).from(tenantLocalization).limit(1);
    if (exists) await db.update(tenantLocalization).set({ country, version: '1', appliedBy: user.username }).where(eq(tenantLocalization.id, exists.id));
    else await db.insert(tenantLocalization).values({ tenantId: user.tenantId ?? null, country, version: '1', appliedBy: user.username });
    return { country, locale: pack.locale, status: pack.status, applied: true };
  }
}
