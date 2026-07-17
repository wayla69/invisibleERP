import { Inject, Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { eq, desc } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../../database/database.module';
import { whtCertificates, whtCertLines, tenants } from '../../../database/schema';
import { DocNumberService } from '../../../common/doc-number.service';
import { n, fx } from '../../../database/queries';
import { roundCurrency } from '../money';
import type { JwtUser } from '../../../common/decorators';
import { payerSnapshot, isValidTaxId } from './tax-docs.snapshot';
import { defaultWhtRate, isAllowedWhtRate, resolvePnd, incomeType, type PayeeKind } from './wht-rates';
import type { IssueWhtDto } from './dto';

@Injectable()
export class WhtService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly docNo: DocNumberService,
  ) {}

  // ออกหนังสือรับรองการหักภาษี ณ ที่จ่าย (50 ทวิ): payer = tenant ปัจจุบัน, payee จาก dto
  async issue(dto: IssueWhtDto, user: JwtUser) {
    const db = this.db;
    const tenantId = user.tenantId;
    if (tenantId == null) {
      throw new BadRequestException({ code: 'NO_TENANT', message: 'A tenant context is required to issue a WHT certificate', messageTh: 'ต้องระบุกิจการผู้จ่ายเงินก่อนออกหนังสือรับรองฯ' });
    }
    const [payer] = await db.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1);
    if (!payer) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Payer (tenant) not found', messageTh: 'ไม่พบข้อมูลผู้จ่ายเงิน' });
    if (!isValidTaxId(payer.taxId)) {
      throw new BadRequestException({ code: 'INVALID_PAYER_TAXID', message: 'Payer Tax ID must be a valid 13-digit number', messageTh: 'เลขประจำตัวผู้เสียภาษีผู้จ่ายไม่ถูกต้อง (13 หลัก)' });
    }
    if (!isValidTaxId(dto.payee.tax_id)) {
      throw new BadRequestException({ code: 'INVALID_PAYEE_TAXID', message: 'Payee Tax ID must be a valid 13-digit number', messageTh: 'เลขประจำตัวผู้เสียภาษีผู้ถูกหักไม่ถูกต้อง (13 หลัก)' });
    }

    const kind = dto.payee.kind as PayeeKind;
    const absorb = dto.condition === 'absorb_always' || dto.condition === 'absorb_once';

    // resolve each line: rate (provided or standard), gross-up if the payer absorbs the tax
    const computed = dto.lines.map((l) => {
      const def = incomeType(l.income_type);
      if (!def) throw new BadRequestException({ code: 'UNKNOWN_INCOME_TYPE', message: `Unknown income type ${l.income_type}`, messageTh: 'ประเภทเงินได้ไม่ถูกต้อง' });
      if (def.requiresDesc && !l.description) throw new BadRequestException({ code: 'DESC_REQUIRED', message: `Description required for income type ${l.income_type}`, messageTh: 'ต้องระบุรายละเอียดประเภทเงินได้' });
      const rate = l.rate ?? defaultWhtRate(l.income_type, kind);
      if (rate == null) throw new BadRequestException({ code: 'RATE_REQUIRED', message: `Rate required for income type ${l.income_type}`, messageTh: 'ต้องระบุอัตราภาษีหัก ณ ที่จ่าย' });
      if (!isAllowedWhtRate(l.income_type, kind, rate)) throw new BadRequestException({ code: 'INVALID_RATE', message: `Rate ${rate} not allowed for ${l.income_type}`, messageTh: 'อัตราภาษีไม่ถูกต้องสำหรับประเภทเงินได้นี้' });
      let base = n(l.amount_paid);
      let taxWithheld: number;
      if (absorb) {
        base = roundCurrency(n(l.amount_paid) / (1 - rate), 'THB'); // gross-up: payer ออกภาษีให้
        taxWithheld = roundCurrency(base * rate, 'THB');
      } else {
        taxWithheld = roundCurrency(base * rate, 'THB');
      }
      return { income_type: l.income_type, description: l.description ?? def.labelTh, date_paid: l.date_paid ?? dto.date_paid, amount_paid: base, rate, tax_withheld: taxWithheld };
    });

    const totalPaid = roundCurrency(computed.reduce((a, l) => a + l.amount_paid, 0), 'THB');
    const totalWht = roundCurrency(computed.reduce((a, l) => a + l.tax_withheld, 0), 'THB');
    const pndType = dto.pnd_type ?? resolvePnd(dto.lines[0]!.income_type, kind);
    const docNo = await this.docNo.nextMonthlyTenant('WHT', tenantId);

    const [head] = await db.insert(whtCertificates).values({
      tenantId, docNo, runNo: dto.run_no ?? null, bookNo: dto.book_no ?? null,
      pndType, formCopy: 'copy1', datePaid: dto.date_paid, ...payerSnapshot(payer),
      payeeName: dto.payee.name, payeeTaxId: dto.payee.tax_id, payeeBranchCode: dto.payee.branch_code ?? null,
      payeeAddress: dto.payee.address ?? null, payeeKind: kind,
      apTxnNo: dto.ap_txn_no ?? null, paymentNo: dto.payment_no ?? null,
      totalPaid: fx(totalPaid, 2), totalWht: fx(totalWht, 2),
      whtCondition: dto.condition ?? 'withhold', whtConditionOther: dto.condition_other ?? null,
      signerName: dto.signer_name ?? null, isReplacement: dto.is_replacement ?? false,
      createdBy: user.username,
    }).returning({ id: whtCertificates.id });

    await db.insert(whtCertLines).values(computed.map((l) => ({
      whtCertId: Number(head!.id), tenantId, incomeType: l.income_type, description: l.description,
      datePaid: l.date_paid, amountPaid: fx(l.amount_paid, 2), rate: String(l.rate), taxWithheld: fx(l.tax_withheld, 2),
    })));

    return this.getByDocNo(user, docNo);
  }

  async list(user: JwtUser, pndType?: string, limit = 50) {
    const db = this.db;
    const where = pndType ? eq(whtCertificates.pndType, pndType as (typeof whtCertificates.$inferSelect)['pndType']) : undefined;
    const rows = await db.select().from(whtCertificates).where(where).orderBy(desc(whtCertificates.id)).limit(limit);
    return { certificates: rows.map(shape), count: rows.length };
  }

  async getByDocNo(user: JwtUser, docNo: string) {
    const db = this.db;
    const [head] = await db.select().from(whtCertificates).where(eq(whtCertificates.docNo, docNo)).limit(1);
    if (!head) throw new NotFoundException({ code: 'NOT_FOUND', message: 'WHT certificate not found', messageTh: 'ไม่พบหนังสือรับรองหักภาษี ณ ที่จ่าย' });
    const lines = await db.select().from(whtCertLines).where(eq(whtCertLines.whtCertId, Number(head.id)));
    return { ...shape(head), lines: lines.map(shapeLine) };
  }

  async void(user: JwtUser, docNo: string) {
    const db = this.db;
    const [head] = await db.select().from(whtCertificates).where(eq(whtCertificates.docNo, docNo)).limit(1);
    if (!head) throw new NotFoundException({ code: 'NOT_FOUND', message: 'WHT certificate not found', messageTh: 'ไม่พบหนังสือรับรองฯ' });
    await db.update(whtCertificates).set({ status: 'Voided' }).where(eq(whtCertificates.id, head.id));
    return { doc_no: docNo, status: 'Voided' };
  }
}

function shape(r: any) {
  return {
    doc_no: r.docNo, pnd_type: r.pndType, status: r.status, date_paid: r.datePaid, book_no: r.bookNo, run_no: r.runNo,
    payer: { name: r.payerName, tax_id: r.payerTaxId, branch_code: r.payerBranchCode, address: r.payerAddress },
    payee: { name: r.payeeName, tax_id: r.payeeTaxId, branch_code: r.payeeBranchCode, address: r.payeeAddress, kind: r.payeeKind },
    ap_txn_no: r.apTxnNo, payment_no: r.paymentNo, total_paid: n(r.totalPaid), total_wht: n(r.totalWht),
    wht_condition: r.whtCondition, wht_condition_other: r.whtConditionOther, signer_name: r.signerName,
    is_replacement: r.isReplacement, created_by: r.createdBy, created_at: r.createdAt,
  };
}
function shapeLine(l: any) {
  return { income_type: l.incomeType, description: l.description, date_paid: l.datePaid, amount_paid: n(l.amountPaid), rate: n(l.rate), tax_withheld: n(l.taxWithheld) };
}
