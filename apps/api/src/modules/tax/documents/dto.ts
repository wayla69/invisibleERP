import { z } from 'zod';

// ── Tax invoices (ใบกำกับภาษี) ──
const BuyerBlock = z.object({
  name: z.string().min(1),
  tax_id: z.string().optional(),
  branch_code: z.string().optional(),
  address: z.string().min(1),
});

// Optional "ชำระเงินโดย" (Paid By) block — a receipt-style payment record, not a ม.86/4-mandatory particular.
// For a POS-sourced invoice the payment method is normally derived from the sale itself (see
// TaxInvoiceService.issueFull); this lets the caller override or supply it for an AR-sourced invoice.
const PaymentBlock = z.object({
  paid_by: z.enum(['transfer', 'cash', 'cheque', 'other']).optional(),
  paid_by_other: z.string().optional(),
  bank: z.string().optional(),
  cheque_no: z.string().optional(),
  branch: z.string().optional(),
});

export const IssueFullBody = z.object({
  source_type: z.enum(['POS', 'AR']),
  source_ref: z.string().min(1),
  buyer: BuyerBlock,
  book_no: z.string().optional(),
  notes: z.string().optional(),
  due_date: z.string().optional(),   // วันครบกำหนดชำระเงิน (mainly for an AR-sourced invoice not yet paid)
  payment: PaymentBlock.optional(),
});
export type IssueFullDto = z.infer<typeof IssueFullBody>;

export const IssueAbbreviatedBody = z.object({
  sale_no: z.string().min(1),
});
export type IssueAbbreviatedDto = z.infer<typeof IssueAbbreviatedBody>;

// ── ABB → full conversion (ม.86/4 on buyer request; POS-1, TAX-10) ──
// The buyer block is MANDATORY here (that is the point of asking for the full invoice): name + address
// per ม.86/4(3), and — unlike IssueFullBody where it is optional — the 13-digit Tax ID is required, since
// the buyer converts precisely to claim input VAT. branch_code is 5 digits, defaulted to 00000 (สำนักงานใหญ่).
export const ConvertAbbBody = z.object({
  buyer: z.object({
    name: z.string().min(1),
    tax_id: z.string().min(1),
    branch_code: z.string().regex(/^\d{5}$/, 'branch_code must be 5 digits').optional(),
    address: z.string().min(1),
  }),
});
export type ConvertAbbDto = z.infer<typeof ConvertAbbBody>;

// ── WHT 50 ทวิ (หนังสือรับรองการหักภาษี ณ ที่จ่าย) ──
const WhtLine = z.object({
  income_type: z.string().min(1),         // '40(2)'|'40(5)'|'3tre-service'|... (see wht-rates.ts)
  description: z.string().optional(),
  date_paid: z.string().optional(),
  amount_paid: z.number().positive(),     // ฐานภาษี (ไม่รวม VAT)
  rate: z.number().positive().max(0.3).optional(), // ถ้าไม่ส่ง ใช้อัตรามาตรฐานของ income type
});

export const IssueWhtBody = z.object({
  pnd_type: z.enum(['PND1K', 'PND1KS', 'PND2', 'PND2K', 'PND3', 'PND3K', 'PND53']).optional(), // ถ้าไม่ส่ง derive
  date_paid: z.string().min(1),
  payee: z.object({
    name: z.string().min(1),
    tax_id: z.string().min(1),
    branch_code: z.string().optional(),
    address: z.string().optional(),
    kind: z.enum(['person', 'company']),
  }),
  ap_txn_no: z.string().optional(),
  payment_no: z.string().optional(),
  condition: z.enum(['withhold', 'absorb_always', 'absorb_once', 'other']).optional(),
  condition_other: z.string().optional(),
  signer_name: z.string().optional(),
  book_no: z.string().optional(),
  run_no: z.string().optional(),
  is_replacement: z.boolean().optional(),
  lines: z.array(WhtLine).min(1),
});
export type IssueWhtDto = z.infer<typeof IssueWhtBody>;
