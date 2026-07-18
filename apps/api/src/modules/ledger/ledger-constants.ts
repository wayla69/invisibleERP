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
  // Everyday SME operating-expense detail (add-on 2026-07-18) — named breakdowns of the 5100 catch-all so a
  // company can post/report by expense kind out of the box (and hang sub-accounts under any of them, e.g.
  // 5110 ค่าเดินทาง → 511001 ค่าเครื่องบิน). All ordinary P&L expenses (no CF_CLASSIFY — captured in net income).
  { code: '5110', name: 'Travel & Transport Expense', type: 'Expense' },   // ค่าเดินทางและขนส่ง
  { code: '5120', name: 'Utilities Expense', type: 'Expense' },            // ค่าสาธารณูปโภค (ไฟฟ้า/น้ำ/อินเทอร์เน็ต)
  { code: '5130', name: 'Rent Expense', type: 'Expense' },                 // ค่าเช่า — short-term / low-value leases (TFRS 16 recognition exemption); capitalised leases use 5210/5900
  { code: '5140', name: 'Marketing & Advertising Expense', type: 'Expense' }, // ค่าการตลาดและโฆษณา
  { code: '5150', name: 'Professional & Legal Fees', type: 'Expense' },    // ค่าธรรมเนียมวิชาชีพและกฎหมาย (audit/legal/consulting)
  { code: '5160', name: 'Office Supplies & Admin Expense', type: 'Expense' }, // ค่าวัสดุสำนักงานและค่าใช้จ่ายบริหาร
  { code: '1500', name: 'Fixed Assets', type: 'Asset' },
  { code: '1520', name: 'Construction in Progress', type: 'Asset' }, // สินทรัพย์ระหว่างก่อสร้าง (CIP/AUC) — accumulates cost until settled to 1500 (FA-13)
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
  { code: '1255', name: 'Goods-in-Transit', type: 'Asset' },            // สินค้าระหว่างทาง — inventory shipped on an inter-warehouse/branch transfer order but not yet received (INV-2/INV-16); Dr on ship, Cr on receive. Distinct from 1250 WIP.
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
  { code: '4600', name: 'Early-Payment Discount Income', type: 'Revenue' },   // ส่วนลดรับจากการจ่ายก่อนกำหนด — cash/prompt-payment discount captured on an early AP payment run (FIN-9, EXP-14); gross-method purchase discount recognised as other income (a P&L revenue account → flows through net income in the indirect SCF; NOT a CF_CLASSIFY balance-sheet bucket)
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
  { code: '5960', name: 'Corporate Income Tax Expense (current)', type: 'Expense' }, // ค่าภาษีเงินได้นิติบุคคล (งวดปัจจุบัน) — current CIT provision (ASC 740 / IAS 12, TAX-11); Dr 5960 / Cr 2110
  { code: '2110', name: 'CIT Payable', type: 'Liability' },                     // ภาษีเงินได้นิติบุคคลค้างจ่าย — current income-tax payable to the Revenue Department (TAX-11)
  { code: '2410', name: 'Contract Liability / Deferred Revenue', type: 'Liability' }, // หนี้สินตามสัญญา/รายได้รอรับรู้ (TFRS 15) — deferred revenue released as POs are satisfied (REV-19)
  { code: '2420', name: 'Refund Liability', type: 'Liability' },               // หนี้สินค่าคืนเงิน — provision for expected returns/refunds (TFRS 15, REV-19)
  { code: '1300', name: 'Input VAT', type: 'Asset' },                         // ภาษีซื้อ — recoverable input VAT (e.g. on subcontractor valuations, docs/35 Depth); also the PP36 self-assessed input-VAT credit (ม.83/6)
  { code: '2120', name: 'PP36 VAT Payable (self-assessed)', type: 'Liability' }, // ภ.พ.36 — VAT self-assessed on imported services (ม.83/6), remitted to RD by the 7th; kept OUT of the ภ.พ.30 (2100) set (separate return)
  { code: '2130', name: 'SBT Payable (ภ.ธ.40)', type: 'Liability' },              // ภาษีธุรกิจเฉพาะค้างจ่าย — SBT on commercial RE sales (ม.91/2(6), 3.3% eff.), remitted on ภ.ธ.40 by the 15th (TAX-09); separate return, out of the VAT sets
  { code: '5840', name: 'Specific Business Tax Expense', type: 'Expense' },       // ค่าภาษีธุรกิจเฉพาะ — SBT borne by the seller, accrued at ownership transfer (Dr 5840 / Cr 2130)
  // Construction/real-estate retention (docs/35 Phase 0) — the shared retention sub-ledger's GL anchors.
  { code: '1170', name: 'Retention Receivable', type: 'Asset' },              // ลูกหนี้เงินประกันผลงาน — retention withheld by the customer on a progress claim, collectible on release (Track A)
  { code: '2440', name: 'Retention Payable', type: 'Liability' },             // เจ้าหนี้เงินประกันผลงาน — retention we withhold from a subcontractor valuation, payable on release (Track B)
  { code: '2220', name: 'Unapplied Customer Receipts', type: 'Liability' },   // เงินรับรอตัดชำระ — on-account AR cash awaiting application to invoices (REV-21); ties to Σ ar_receipts.unapplied_amount
  // Lessor-side lease accounting (IFRS 16 / TFRS 16 lessor) — control LSE-02 (FIN-10).
  { code: '1610', name: 'Net Investment in Lease (Lease Receivable)', type: 'Asset' }, // เงินลงทุนสุทธิในสัญญาเช่า/ลูกหนี้ตามสัญญาเช่า — finance-lease receivable (lessor); ties to Σ lessor_leases.receivable_balance
  { code: '4600', name: 'Finance Lease Interest Income', type: 'Revenue' },   // ดอกเบี้ยรับตามสัญญาเช่าการเงิน — interest income unwound on the net investment (lessor finance lease)
  { code: '4610', name: 'Operating Lease Rental Income', type: 'Revenue' },   // รายได้ค่าเช่าตามสัญญาเช่าดำเนินงาน — straight-line rental income (lessor operating lease)
  { code: '4650', name: 'Significant Financing Component Interest Income', type: 'Revenue' }, // ดอกเบี้ยรับจากองค์ประกอบทางการเงินที่มีนัยสำคัญ (TFRS 15 §60-65) — interest income when the entity FINANCES the customer (deferred payment / arrears): the contract asset accretes from PV toward face (Dr 1265 / Cr 4650, REV-27); the customer-PREPAYS (advance) case is interest expense and reuses 5900 (Dr 5900 / Cr 2410)

  // Landed-cost accrual (INV-1, COST-01) — freight/duty/insurance/broker payable, credited when a landed-cost
  // voucher capitalises those charges into inventory unit cost (Dr 1200 / Dr 5500 variance / Cr 2010).
  { code: '2010', name: 'Landed-Cost Accrual', type: 'Liability' },          // เจ้าหนี้ค่าขนส่ง/อากร/ประกันภัย/นายหน้า (ต้นทุนแฝง) — landed-cost charges accrued at capitalisation
  // Debt & borrowings register (Track C Wave 1, TRE-01) — a drawdown books principal to the short-/long-term
  // borrowings control (2500/2550); the EIR amortized-cost accrual credits accrued interest payable (2450).
  { code: '2450', name: 'Accrued Interest Payable', type: 'Liability' },      // ดอกเบี้ยค้างจ่าย — accrued-but-unpaid interest on borrowings (EIR accrual, Cr; cleared on repayment)
  { code: '2500', name: 'Short-term Borrowings', type: 'Liability' },         // เงินกู้ยืมระยะสั้น — principal drawn on a short-term facility (Cr at drawdown, Dr on repayment)
  { code: '2550', name: 'Long-term Borrowings', type: 'Liability' },          // เงินกู้ยืมระยะยาว — principal drawn on a long-term facility (Cr at drawdown, Dr on repayment)
  // Investment & Securities register (Track C Wave 2, TRE-03) — a purchase books cost to the class asset
  // (1350/1360/1370); FVOCI mark-to-market moves through the OCI equity reserve 3500 (the reusable OCI-reserve
  // primitive), FVTPL through P&L 5430; interest/dividend income → 4700; ECL impairment Dr 5440 / Cr allowance 1355.
  { code: '1350', name: 'Investments — Amortized Cost', type: 'Asset' },      // เงินลงทุน–ราคาทุนตัดจำหน่าย (held-to-collect debt securities, EIR)
  { code: '1355', name: 'Allowance for Investment ECL', type: 'Asset' },      // ค่าเผื่อการด้อยค่าเงินลงทุน — contra-asset (normal credit bal); Cr from the ECL impairment (TRE-03)
  { code: '1360', name: 'Investments — FVOCI', type: 'Asset' },               // เงินลงทุน–มูลค่ายุติธรรมผ่านกำไรขาดทุนเบ็ดเสร็จอื่น (fair value through OCI)
  { code: '1370', name: 'Investments — FVTPL', type: 'Asset' },               // เงินลงทุน–มูลค่ายุติธรรมผ่านกำไรขาดทุน (fair value through profit or loss)
  { code: '3500', name: 'FVOCI Reserve (OCI)', type: 'Equity' },              // สำรองมูลค่ายุติธรรม (กำไรขาดทุนเบ็ดเสร็จอื่น) — FVOCI cumulative MTM reserve in equity (reusable OCI-reserve primitive; Wave 3 hedge accounting reuses it)
  { code: '4700', name: 'Investment Income', type: 'Revenue' },               // รายได้จากเงินลงทุน — interest (amortized-cost accretion) + dividends (TRE-03)
  { code: '5430', name: 'Fair-value Gain/Loss (FVTPL)', type: 'Expense' },    // กำไร/ขาดทุนจากการวัดมูลค่ายุติธรรม (FVTPL) — MTM through P&L; gain=credit, loss=debit
  { code: '5440', name: 'Investment Impairment (ECL)', type: 'Expense' },     // ผลขาดทุนจากการด้อยค่าเงินลงทุน — ECL impairment (Dr 5440 / Cr 1355 allowance, TRE-03)
  // Hedge accounting register (Track C Wave 3, TRE-04; IFRS 9 / TFRS 9 · ASC 815) — a derivative's fair-value
  // change books to the derivative asset/liability (1380/2460); a CASH_FLOW hedge defers its EFFECTIVE portion
  // in the Cash-Flow Hedge Reserve 3550 (OCI equity, mirroring the FVOCI reserve 3500) and its INEFFECTIVE
  // portion to P&L 5450; a FAIR_VALUE hedge routes the derivative change to P&L 5450 and basis-adjusts the
  // hedged item's own carrying account. Reclassification recycles 3550 → the hedged-item revenue/P&L line.
  { code: '1380', name: 'Derivative Asset', type: 'Asset' },                  // สินทรัพย์อนุพันธ์ — hedging-instrument positive fair value (Dr on a derivative gain, TRE-04)
  { code: '2460', name: 'Derivative Liability', type: 'Liability' },          // หนี้สินอนุพันธ์ — hedging-instrument negative fair value (Cr on a derivative loss, TRE-04)
  { code: '3550', name: 'Cash-Flow Hedge Reserve (OCI)', type: 'Equity' },    // สำรองการป้องกันความเสี่ยงกระแสเงินสด (OCI equity) — effective portion of a CASH_FLOW hedge deferred in OCI, recycled to P&L when the hedged cash flow occurs (TRE-04)
  { code: '5450', name: 'Hedge Ineffectiveness / Fair-value Hedge P&L', type: 'Expense' }, // ผล(ขาดทุน)กำไรการป้องกันความเสี่ยงที่ไม่มีประสิทธิผล — ineffective portion of a CF hedge + the FV-hedge derivative/basis P&L (gain=credit, loss=debit, TRE-04)
  // Cash pooling / in-house bank / intercompany-loan register (Track C Wave 4, TRE-05) — an IC loan books the
  // principal to the IC-loan receivable (creditor, 1155) and IC-loan payable (debtor, 2155); EIR interest accrues
  // Cr 4700 Investment/Interest Income (creditor) / Dr 5900 Interest Expense (debtor). BOTH the 1155/2155 pair
  // AND the 4700/5900 IC interest ELIMINATE on consolidation (mirroring the 1150/2150 IC pair) so group balances
  // and group finance cost/income net to zero. Distinct from the trade IC 1150/2150 (which are operating): an IC
  // loan is a financing/investing instrument, so its receivable buckets investing and its payable financing.
  { code: '1155', name: 'Intercompany Loan Receivable', type: 'Asset' },      // ลูกหนี้เงินให้กู้ยืมระหว่างบริษัท — creditor side of an IC loan (elimination pair with 2155, TRE-05)
  { code: '2155', name: 'Intercompany Loan Payable', type: 'Liability' },     // เจ้าหนี้เงินกู้ยืมระหว่างบริษัท — debtor side of an IC loan (elimination pair with 1155, TRE-05)
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
  '1255': { bucket: 'operating', label: 'สินค้าระหว่างทาง (Goods-in-transit)' }, // INV-2/INV-16 — inter-warehouse transfer value in transit (working-capital asset)
  '1260': { bucket: 'operating', label: 'ต้นทุนโครงการที่ยังไม่เรียกเก็บ (Unbilled project cost)' },
  '1265': { bucket: 'operating', label: 'สินทรัพย์ตามสัญญา (Contract asset / unbilled receivable)' },
  '1170': { bucket: 'operating', label: 'ลูกหนี้เงินประกันผลงาน (Retention receivable)' }, // docs/35 Phase 0 — retention withheld by customers (working-capital asset)
  '1300': { bucket: 'operating', label: 'ภาษีซื้อ (Input VAT recoverable)' }, // docs/35 Depth — recoverable input VAT (working-capital asset)
  // Operating — current liabilities (an increase releases cash)
  '2000': { bucket: 'operating', label: 'เจ้าหนี้การค้า (Accounts payable)' },
  '2010': { bucket: 'operating', label: 'เจ้าหนี้ต้นทุนแฝง (Landed-cost accrual)' }, // INV-1 COST-01 — freight/duty/insurance/broker payable (working-capital liability)
  '2440': { bucket: 'operating', label: 'เจ้าหนี้เงินประกันผลงาน (Retention payable)' }, // docs/35 Phase 0 — retention withheld from subcontractors (working-capital liability)
  '2100': { bucket: 'operating', label: 'ภาษีค้างจ่าย (Tax payable)' },
  '2110': { bucket: 'operating', label: 'ภาษีเงินได้นิติบุคคลค้างจ่าย (CIT payable)' }, // TAX-11 — current income-tax payable (working-capital liability)
  '2120': { bucket: 'operating', label: 'ภาษีขายนำส่ง ภ.พ.36 (PP36 VAT payable, self-assessed)' }, // imported-service reverse-charge VAT payable (ม.83/6)
  '2130': { bucket: 'operating', label: 'ภาษีธุรกิจเฉพาะค้างจ่าย ภ.ธ.40 (SBT payable)' }, // SBT on commercial RE sales (ม.91/2(6))
  '2150': { bucket: 'operating', label: 'เจ้าหนี้ระหว่างบริษัท (Intercompany payable)' },
  '2200': { bucket: 'operating', label: 'เงินมัดจำลูกค้า/บัตรของขวัญ (Customer deposits)' },
  '2210': { bucket: 'operating', label: 'เงินรับล่วงหน้า (Customer deposits — prepaid)' },
  '2220': { bucket: 'operating', label: 'เงินรับรอตัดชำระ (Unapplied customer receipts)' }, // REV-21 — on-account AR cash (working-capital liability)
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
  // TFRS 15 §60-65 significant-financing-component interest income (REV-27) — a revenue-side financing item.
  // As a P&L Revenue account it is already captured in net income by the indirect SCF (which skips
  // Revenue/Expense accounts before this map is read), so this entry is documentary: it records the operating
  // classification of the financing benefit (the unwind touches the operating working-capital account 2410).
  '4650': { bucket: 'operating', label: 'ดอกเบี้ยรับองค์ประกอบทางการเงิน (Significant financing component interest income)' },
  '2450': { bucket: 'operating', label: 'ดอกเบี้ยค้างจ่าย (Accrued interest payable)' }, // TRE-01 — EIR accrual on borrowings (working-capital liability; interest expense flows through net income)
  // Operating — other current assets (an increase ties up cash)
  '1180': { bucket: 'operating', label: 'เงินทดรองจ่ายพนักงาน (Employee advances)' },
  '1280': { bucket: 'operating', label: 'ค่าใช้จ่ายจ่ายล่วงหน้า (Prepaid expenses)' },
  // Non-cash add-back — accumulated ROU depreciation (contra-asset, credit-normal)
  '1690': { bucket: 'addback', label: 'ค่าเสื่อมสะสม–สินทรัพย์สิทธิการใช้ (Accumulated ROU depreciation)' },
  // Investing — property, plant & equipment + right-of-use assets (gross)
  '1500': { bucket: 'investing', label: 'ซื้อ/จำหน่ายสินทรัพย์ถาวร (Purchase/disposal of fixed assets)' },
  '1520': { bucket: 'investing', label: 'สินทรัพย์ระหว่างก่อสร้าง (Construction in progress / AUC)' }, // FA-13 — CIP cost accumulation, an investing outflow
  '1600': { bucket: 'investing', label: 'สินทรัพย์สิทธิการใช้ (Right-of-use assets)' },
  '1610': { bucket: 'investing', label: 'เงินลงทุนสุทธิในสัญญาเช่าการเงิน (Net investment in finance leases)' }, // FIN-10 lessor — collections of the net investment (principal) are investing flows
  // Investing — marketable investments & securities (TRE-03). Purchases are investing outflows; the ECL
  // allowance (1355, contra-asset) nets against the amortized-cost holding. FVOCI/FVTPL MTM is a NON-CASH
  // remeasurement (asset ↔ 3500 OCI reserve / 5430 P&L), so it self-cancels in the SCF reconciliation.
  '1350': { bucket: 'investing', label: 'เงินลงทุน–ราคาทุนตัดจำหน่าย (Investments — amortized cost)' },
  '1355': { bucket: 'investing', label: 'ค่าเผื่อการด้อยค่าเงินลงทุน (Allowance for investment ECL)' },
  '1360': { bucket: 'investing', label: 'เงินลงทุน–มูลค่ายุติธรรมผ่าน OCI (Investments — FVOCI)' },
  '1370': { bucket: 'investing', label: 'เงินลงทุน–มูลค่ายุติธรรมผ่านกำไรขาดทุน (Investments — FVTPL)' },
  // Financing — borrowings (TRE-01 debt register), owners' equity, dividends, lease liabilities
  '2500': { bucket: 'financing', label: 'เงินกู้ยืมระยะสั้น (Short-term borrowings)' },   // TRE-01 — drawdowns/repayments of principal are financing flows
  '2550': { bucket: 'financing', label: 'เงินกู้ยืมระยะยาว (Long-term borrowings)' },    // TRE-01 — drawdowns/repayments of principal are financing flows
  '2600': { bucket: 'financing', label: 'หนี้สินตามสัญญาเช่า (Lease liabilities)' },
  '3000': { bucket: 'financing', label: 'ส่วนทุน/เงินลงทุนจากเจ้าของ (Owner capital contributions)' },
  '3100': { bucket: 'financing', label: 'เงินปันผลจ่าย / กำไรสะสม (Dividends paid)' },
  '3200': { bucket: 'financing', label: 'ส่วนเกินทุนจากการตีราคา (Revaluation surplus)' },
  '3500': { bucket: 'financing', label: 'สำรองมูลค่ายุติธรรม FVOCI (FVOCI reserve, OCI)' }, // TRE-03 — FVOCI cumulative MTM equity reserve (non-cash remeasurement; mirrors 3200 handling)
  '3550': { bucket: 'financing', label: 'สำรองการป้องกันความเสี่ยงกระแสเงินสด (Cash-flow hedge reserve, OCI)' }, // TRE-04 — CF-hedge OCI equity reserve (non-cash remeasurement; mirrors 3500/3200 handling)
  // Hedge accounting derivatives (TRE-04) — a hedging derivative's fair value is a non-cash risk-management
  // remeasurement (asset/liability ↔ 3550 OCI / 5450 P&L), so it self-cancels in the SCF reconciliation.
  '1380': { bucket: 'operating', label: 'สินทรัพย์อนุพันธ์ (Derivative asset — hedging instruments)' },
  '2460': { bucket: 'operating', label: 'หนี้สินอนุพันธ์ (Derivative liability — hedging instruments)' },
  // Intercompany-loan register (TRE-05) — an IC loan is a financing/investing instrument (unlike the trade IC
  // 1150/2150 operating pair): the creditor's loan receivable is an investing outflow, the debtor's loan payable
  // a financing inflow. Both ELIMINATE on consolidation, so at the group layer they self-cancel.
  '1155': { bucket: 'investing', label: 'ลูกหนี้เงินให้กู้ยืมระหว่างบริษัท (Intercompany loan receivable)' },
  '2155': { bucket: 'financing', label: 'เจ้าหนี้เงินกู้ยืมระหว่างบริษัท (Intercompany loan payable)' },
};
