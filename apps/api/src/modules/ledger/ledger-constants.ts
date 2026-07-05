// GL reference data extracted from ledger.service.ts (behaviour-zero). The Chart of Accounts, the parallel
// ledgers (TFRS/TAX/IFRS), the cash-account set, and the cash-flow classification map. Per CLAUDE.md these
// are the place to ADD a new balance-sheet account / CF bucket, so a dedicated module makes them findable.
// Parallel sets of books. The LEADING ledger is the statutory/primary book — reports default to it, and a
// journal with ledger_code = NULL is shared by every ledger (so all existing postings are universal).
export const LEADING = 'TFRS';
export const LEDGERS: { code: string; name: string; gaap: string; isLeading: boolean; description: string }[] = [
  { code: 'TFRS', name: 'TFRS (งบตามกฎหมาย)', gaap: 'TFRS', isLeading: true, description: 'Thai Financial Reporting Standards — statutory financial statements' },
  { code: 'TAX', name: 'ฐานภาษีสรรพากร', gaap: 'TAX', isLeading: false, description: 'Revenue Department basis — depreciation/expenses per the Revenue Code (book-tax differences)' },
  { code: 'IFRS', name: 'IFRS (กลุ่มบริษัท)', gaap: 'IFRS', isLeading: false, description: 'IFRS basis for group consolidation' },
];

// minimal Chart of Accounts (code, name, type)
export const COA: { code: string; name: string; type: 'Asset' | 'Liability' | 'Equity' | 'Revenue' | 'Expense' }[] = [
  { code: '1000', name: 'Cash', type: 'Asset' },
  { code: '1100', name: 'Accounts Receivable', type: 'Asset' },
  { code: '1200', name: 'Inventory', type: 'Asset' },
  { code: '2000', name: 'Accounts Payable', type: 'Liability' },
  { code: '2100', name: 'Tax Payable', type: 'Liability' },
  { code: '3000', name: 'Equity', type: 'Equity' },
  { code: '3100', name: 'Retained Earnings', type: 'Equity' },
  { code: '4000', name: 'Sales Revenue', type: 'Revenue' },
  { code: '5000', name: 'COGS', type: 'Expense' },
  { code: '5100', name: 'Operating Expense', type: 'Expense' },
  { code: '1500', name: 'Fixed Assets', type: 'Asset' },
  { code: '1590', name: 'Accumulated Depreciation', type: 'Asset' }, // contra-asset (normal credit bal)
  { code: '5200', name: 'Depreciation Expense', type: 'Expense' },
  { code: '1510', name: 'Gain/Loss on Disposal', type: 'Revenue' }, // gain=credit, loss=debit
  { code: '1010', name: 'Bank — Current', type: 'Asset' }, // house-bank GL accounts (bank reconciliation)
  { code: '1015', name: 'Petty Cash', type: 'Asset' }, // petty-cash imprest float (EXP-08) — a cash account
  { code: '1020', name: 'Bank — Savings', type: 'Asset' },
  { code: '2400', name: 'Unearned Revenue', type: 'Liability' }, // รายได้รอตัดบัญชี — deferred revenue
  { code: '5400', name: 'FX Gain/Loss (Unrealized)', type: 'Expense' }, // กำไร/ขาดทุนอัตราแลกเปลี่ยน — loss=debit, gain=credit
  { code: '1150', name: 'Intercompany Receivable', type: 'Asset' },     // Due From group company
  { code: '2150', name: 'Intercompany Payable', type: 'Liability' },    // Due To group company
  { code: '5300', name: 'Recipe COGS', type: 'Expense' },               // ตัดวัตถุดิบตามสูตร (recipe ingredient COGS)
  { code: '2200', name: 'Customer Deposits', type: 'Liability' },       // gift cards / store credit (unredeemed) — บัตรของขวัญ/เครดิตร้านค้า
  { code: '2300', name: 'Tips Payable', type: 'Liability' },            // staff tip pass-through (not revenue, not VATable) — ทิปพนักงาน
  { code: '4100', name: 'Delivery Income', type: 'Revenue' },           // รายได้ค่าจัดส่ง (VATable, separate from food sales 4000)
  { code: '5500', name: 'Purchase Price Variance', type: 'Expense' },   // STD costing PPV — unfavorable=debit, favorable=credit
  { code: '5600', name: 'Salaries & Wages', type: 'Expense' },          // เงินเดือน — payroll gross
  { code: '5610', name: 'Social Security (Employer)', type: 'Expense' }, // เงินสมทบประกันสังคมส่วนนายจ้าง
  { code: '2350', name: 'Social Security Payable', type: 'Liability' }, // ประกันสังคมค้างจ่าย (ลูกจ้าง+นายจ้าง)
  { code: '2360', name: 'Payroll WHT Payable (PND1)', type: 'Liability' }, // ภาษีหัก ณ ที่จ่ายเงินเดือน (ภ.ง.ด.1) ค้างจ่าย
  { code: '2361', name: 'Vendor WHT Payable (PND3/53)', type: 'Liability' }, // ภาษีหัก ณ ที่จ่ายผู้ขาย (ภ.ง.ด.3/53) ค้างจ่าย — withheld at AP payment, remitted to RD (TAX-03)
  { code: '1250', name: 'Work-in-Process', type: 'Asset' },             // งานระหว่างทำ (WIP) — manufacturing
  { code: '1210', name: 'Finished Goods', type: 'Asset' },              // สินค้าสำเร็จรูป — จากใบสั่งผลิต
  { code: '2380', name: 'Manufacturing Costs Applied', type: 'Liability' }, // ค่าแรง/โสหุ้ยการผลิตที่คิดเข้างาน (clearing)
  { code: '1260', name: 'Project WIP / Unbilled Cost', type: 'Asset' },  // ต้นทุนงานโครงการที่ยังไม่รับรู้
  { code: '1265', name: 'Contract Asset (Unbilled Receivable)', type: 'Asset' }, // สินทรัพย์ตามสัญญา — รายได้ที่รับรู้แล้วแต่ยังไม่เรียกเก็บ (POC, PROJ-09)
  { code: '2390', name: 'Project Costs Applied', type: 'Liability' },    // ต้นทุนโครงการคิดเข้างาน (clearing)
  { code: '4200', name: 'Project Revenue', type: 'Revenue' },            // รายได้งานโครงการ
  { code: '5800', name: 'Project Cost of Services', type: 'Expense' },   // ต้นทุนงานบริการโครงการ
  { code: '5810', name: 'Scrap / Rework Loss', type: 'Expense' },        // ผลขาดทุนจากของเสีย/แก้ไขงาน (QA)
  { code: '5620', name: 'Provident Fund (Employer)', type: 'Expense' },  // เงินสมทบกองทุนสำรองเลี้ยงชีพส่วนนายจ้าง
  { code: '2370', name: 'Provident Fund Payable', type: 'Liability' },   // กองทุนสำรองเลี้ยงชีพค้างจ่าย (ลูกจ้าง+นายจ้าง)
  { code: '4300', name: 'Subscription & Service Revenue', type: 'Revenue' }, // รายได้ค่าบริการ/สมาชิกแบบเรียกเก็บประจำ
  { code: '4400', name: 'Service Charge Income', type: 'Revenue' },          // รายได้ค่าบริการ (เซอร์วิสชาร์จ) — VATable, auto for large parties
  { code: '4900', name: 'Rounding Adjustment', type: 'Revenue' },            // ปัดเศษสตางค์ — rounded up=credit (gain), down=debit (loss)
  { code: '2210', name: 'Customer Deposits — Prepaid', type: 'Liability' },  // มัดจำ/เงินรับล่วงหน้า (booking/tab) — recognised to revenue on apply
  { code: '4500', name: 'Card Surcharge Income', type: 'Revenue' },          // รายได้ค่าธรรมเนียมบัตร — VATable card surcharge
  { code: '5410', name: 'FX Gain/Loss (Realized)', type: 'Expense' },        // กำไร/ขาดทุนอัตราแลกเปลี่ยนที่เกิดขึ้นจริง — loss=debit, gain=credit (settlement)
  { code: '2250', name: 'Loyalty Points Liability', type: 'Liability' },      // หนี้สินแต้มสะสม — TFRS 15 contract liability for outstanding loyalty points (control acct)
  { code: '5700', name: 'Loyalty Points Expense', type: 'Expense' },          // ค่าใช้จ่ายแต้มสะสม — provision for loyalty points granted (offsets 2250)
  { code: '5710', name: 'Repairs & Maintenance', type: 'Expense' },           // ค่าซ่อมแซมและบำรุงรักษา — EAM maintenance work-order cost
  { code: '5720', name: 'Bad Debt Expense', type: 'Expense' },                // หนี้สูญ — uncollectible AR written off (Dr 5720 / Cr 1100, REV-14 maker-checker)
  { code: '1180', name: 'Employee Advances', type: 'Asset' },                  // เงินทดรองจ่ายพนักงาน — petty-cash / cash advances outstanding
  { code: '1190', name: 'Allowance for Doubtful Accounts', type: 'Asset' },    // ค่าเผื่อหนี้สงสัยจะสูญ — contra-asset (normal credit bal); Cr from ECL provision (REV-18)
  { code: '1280', name: 'Prepaid Expenses', type: 'Asset' },                   // ค่าใช้จ่ายจ่ายล่วงหน้า — prepaid asset (amortized over its term)
  { code: '1600', name: 'Right-of-Use Asset', type: 'Asset' },                 // สินทรัพย์สิทธิการใช้ (IFRS 16/TFRS 16)
  { code: '1690', name: 'Accumulated Depreciation — ROU', type: 'Asset' },     // ค่าเสื่อมสะสม–สินทรัพย์สิทธิการใช้ (contra-asset)
  { code: '2600', name: 'Lease Liability', type: 'Liability' },                // หนี้สินตามสัญญาเช่า (IFRS 16/TFRS 16)
  { code: '3200', name: 'Revaluation Surplus', type: 'Equity' },               // ส่วนเกินทุนจากการตีราคาสินทรัพย์ (asset revaluation reserve)
  { code: '5210', name: 'Depreciation Expense — ROU', type: 'Expense' },       // ค่าเสื่อมราคาสินทรัพย์สิทธิการใช้
  { code: '5820', name: 'Impairment Loss', type: 'Expense' },                  // ผลขาดทุนจากการด้อยค่าสินทรัพย์
  { code: '5900', name: 'Interest Expense', type: 'Expense' },                 // ดอกเบี้ยจ่าย — incl. lease-liability unwinding
  { code: '5830', name: 'Cash Over/Short', type: 'Expense' },                  // เงินสดขาด/เกินบัญชี — POS-01 till-close variance (short=debit, over=credit)
  { code: '1700', name: 'Deferred Tax Asset', type: 'Asset' },                 // สินทรัพย์ภาษีเงินได้รอการตัดบัญชี (TAS 12) — deductible temporary differences × CIT (TAX-06)
  { code: '2700', name: 'Deferred Tax Liability', type: 'Liability' },         // หนี้สินภาษีเงินได้รอการตัดบัญชี (TAS 12) — taxable temporary differences × CIT (TAX-06)
  { code: '5950', name: 'Deferred Tax Expense', type: 'Expense' },             // ค่าใช้จ่าย(รายได้)ภาษีเงินได้รอการตัดบัญชี — deferred tax expense/benefit (TAX-06)
  { code: '2410', name: 'Contract Liability / Deferred Revenue', type: 'Liability' }, // หนี้สินตามสัญญา/รายได้รอรับรู้ (TFRS 15) — deferred revenue released as POs are satisfied (REV-19)
  { code: '2420', name: 'Refund Liability', type: 'Liability' },               // หนี้สินค่าคืนเงิน — provision for expected returns/refunds (TFRS 15, REV-19)
  { code: '1300', name: 'Input VAT', type: 'Asset' },                         // ภาษีซื้อ — recoverable input VAT (e.g. on subcontractor valuations, docs/35 Depth)
  // Construction/real-estate retention (docs/35 Phase 0) — the shared retention sub-ledger's GL anchors.
  { code: '1170', name: 'Retention Receivable', type: 'Asset' },              // ลูกหนี้เงินประกันผลงาน — retention withheld by the customer on a progress claim, collectible on release (Track A)
  { code: '2440', name: 'Retention Payable', type: 'Liability' },             // เจ้าหนี้เงินประกันผลงาน — retention we withhold from a subcontractor valuation, payable on release (Track B)
];

// ───────────────────── Statement of Cash Flows (indirect method) classification ─────────────────────
// Cash & cash-equivalents — the accounts the statement EXPLAINS (movement is the bottom line, not a flow).
export const CASH_ACCOUNTS = ['1000', '1010', '1015', '1020'];
export type CfBucket = 'addback' | 'operating' | 'investing' | 'financing';
// Maps every NON-cash balance-sheet account to a cash-flow section. The indirect method starts operating
// cash from net income, then layers (a) non-cash add-backs and (b) working-capital movements. Every
// balance-sheet account is bucketed exactly once so the statement reconciles to the change in cash by
// double-entry construction (Σ all accounts' debit−credit = 0). Accounts absent here fall back by type.
export const CF_CLASSIFY: Record<string, { bucket: CfBucket; label: string }> = {
  // Non-cash add-backs (P&L charge that consumed no cash) — accumulated depreciation (contra-asset, credit-normal).
  '1590': { bucket: 'addback', label: 'ค่าเสื่อมราคาและค่าตัดจำหน่าย (Depreciation & amortization)' },
  // Operating — current assets (an increase ties up cash)
  '1100': { bucket: 'operating', label: 'ลูกหนี้การค้า (Accounts receivable)' },
  '1150': { bucket: 'operating', label: 'ลูกหนี้ระหว่างบริษัท (Intercompany receivable)' },
  '1200': { bucket: 'operating', label: 'สินค้าคงเหลือ (Inventory)' },
  '1210': { bucket: 'operating', label: 'สินค้าสำเร็จรูป (Finished goods)' },
  '1250': { bucket: 'operating', label: 'งานระหว่างทำ (Work-in-process)' },
  '1260': { bucket: 'operating', label: 'ต้นทุนโครงการที่ยังไม่เรียกเก็บ (Unbilled project cost)' },
  '1265': { bucket: 'operating', label: 'สินทรัพย์ตามสัญญา (Contract asset / unbilled receivable)' },
  '1170': { bucket: 'operating', label: 'ลูกหนี้เงินประกันผลงาน (Retention receivable)' }, // docs/35 Phase 0 — retention withheld by customers (working-capital asset)
  '1300': { bucket: 'operating', label: 'ภาษีซื้อ (Input VAT recoverable)' }, // docs/35 Depth — recoverable input VAT (working-capital asset)
  // Operating — current liabilities (an increase releases cash)
  '2000': { bucket: 'operating', label: 'เจ้าหนี้การค้า (Accounts payable)' },
  '2440': { bucket: 'operating', label: 'เจ้าหนี้เงินประกันผลงาน (Retention payable)' }, // docs/35 Phase 0 — retention withheld from subcontractors (working-capital liability)
  '2100': { bucket: 'operating', label: 'ภาษีค้างจ่าย (Tax payable)' },
  '2150': { bucket: 'operating', label: 'เจ้าหนี้ระหว่างบริษัท (Intercompany payable)' },
  '2200': { bucket: 'operating', label: 'เงินมัดจำลูกค้า/บัตรของขวัญ (Customer deposits)' },
  '2210': { bucket: 'operating', label: 'เงินรับล่วงหน้า (Customer deposits — prepaid)' },
  '2300': { bucket: 'operating', label: 'ทิปค้างจ่าย (Tips payable)' },
  '2350': { bucket: 'operating', label: 'ประกันสังคมค้างจ่าย (Social security payable)' },
  '2360': { bucket: 'operating', label: 'ภาษีหัก ณ ที่จ่ายเงินเดือนค้างจ่าย (Payroll WHT payable)' },
  '2361': { bucket: 'operating', label: 'ภาษีหัก ณ ที่จ่ายผู้ขายค้างจ่าย (Vendor WHT payable)' },
  '2370': { bucket: 'operating', label: 'กองทุนสำรองเลี้ยงชีพค้างจ่าย (Provident fund payable)' },
  '2380': { bucket: 'operating', label: 'ค่าใช้จ่ายการผลิตรอปันส่วน (Manufacturing costs applied)' },
  '2390': { bucket: 'operating', label: 'ต้นทุนโครงการรอปันส่วน (Project costs applied)' },
  '2400': { bucket: 'operating', label: 'รายได้รับล่วงหน้า (Unearned revenue)' },
  '2410': { bucket: 'operating', label: 'หนี้สินตามสัญญา/รายได้รอรับรู้ (Contract liability / deferred revenue)' },
  '2420': { bucket: 'operating', label: 'หนี้สินค่าคืนเงิน (Refund liability)' },
  // Operating — other current assets (an increase ties up cash)
  '1180': { bucket: 'operating', label: 'เงินทดรองจ่ายพนักงาน (Employee advances)' },
  '1280': { bucket: 'operating', label: 'ค่าใช้จ่ายจ่ายล่วงหน้า (Prepaid expenses)' },
  // Non-cash add-back — accumulated ROU depreciation (contra-asset, credit-normal)
  '1690': { bucket: 'addback', label: 'ค่าเสื่อมสะสม–สินทรัพย์สิทธิการใช้ (Accumulated ROU depreciation)' },
  // Investing — property, plant & equipment + right-of-use assets (gross)
  '1500': { bucket: 'investing', label: 'ซื้อ/จำหน่ายสินทรัพย์ถาวร (Purchase/disposal of fixed assets)' },
  '1600': { bucket: 'investing', label: 'สินทรัพย์สิทธิการใช้ (Right-of-use assets)' },
  // Financing — owners' equity, dividends, lease liabilities
  '2600': { bucket: 'financing', label: 'หนี้สินตามสัญญาเช่า (Lease liabilities)' },
  '3000': { bucket: 'financing', label: 'ส่วนทุน/เงินลงทุนจากเจ้าของ (Owner capital contributions)' },
  '3100': { bucket: 'financing', label: 'เงินปันผลจ่าย / กำไรสะสม (Dividends paid)' },
  '3200': { bucket: 'financing', label: 'ส่วนเกินทุนจากการตีราคา (Revaluation surplus)' },
};
