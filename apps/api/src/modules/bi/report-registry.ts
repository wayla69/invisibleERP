// Report registry (docs/38 §3 bi pilot, extraction PR-1). The catalog of report types a subscription may
// schedule + the allowed frequencies — moved verbatim out of bi.service.ts (the first, deliberately
// trivial cut of the decomposition: a pure const module, no DI, so the BiService constructor and public
// API are provably byte-identical). Each key maps to a generator branch in BiService.generateReport;
// the catalog drives create-time validation and the report-type picker in the builder UI.
export const REPORT_TYPES: Record<string, { label: string; labelEn: string }> = {
  kpi_board:      { label: 'สรุป KPI', labelEn: 'KPI board' },
  sales_cube:     { label: 'ยอดขายตามช่วงเวลา', labelEn: 'Sales cube' },
  finance_trend:  { label: 'แนวโน้มกำไร-ขาดทุน', labelEn: 'Finance (P&L) trend' },
  pipeline_trend: { label: 'แนวโน้มไปป์ไลน์', labelEn: 'Pipeline trend' },
  // Portfolio earned-value: every project's CPI/SPI + totals + the at-risk list. Read-only (rides evm()).
  project_evm: { label: 'มูลค่าที่ได้รับของพอร์ตโครงการ (EVM)', labelEn: 'Portfolio earned value (EVM)' },
  // CRM win/loss: win rate, loss reasons, by-owner, monthly trend. Read-only.
  crm_win_loss: { label: 'วิเคราะห์ Win/Loss', labelEn: 'CRM win/loss analytics' },
  // CRM-5 analytics ("why") — read-only aggregators on the CRM spine, all date-bounded server-side.
  // Funnel conversion (lead→qualified→won) + stage-to-stage progression + time-in-stage velocity (crm_stage_history).
  crm_funnel: { label: 'วิเคราะห์กรวยการขาย + ความเร็ว', labelEn: 'CRM funnel conversion + velocity' },
  // Lead source → won revenue (win rate + average deal size per channel).
  crm_source_roi: { label: 'ผลตอบแทนตามแหล่งที่มา (Source ROI)', labelEn: 'CRM source ROI (won revenue by source)' },
  // G4 (docs/45): one exec view of marketing spend → lift → margin (campaign attribution + vouchers + B2B + budget)
  marketing_roi: { label: 'ผลตอบแทนการตลาด (spend → lift → margin)', labelEn: 'Marketing ROI (spend → lift → margin)' },
  // Forecast categories (commit/best-case/pipeline) + quota attainment per owner + activity leaderboard.
  crm_forecast: { label: 'พยากรณ์การขาย + โควตา', labelEn: 'CRM forecast categories + quota attainment' },
  // Likewise: each run re-profiles the tenant's whole active member base (RFM) so segments stay fresh (F2).
  crm_profile_refresh: { label: 'รีเฟรชโปรไฟล์ลูกค้า (RFM)', labelEn: 'CRM profile refresh (RFM)' },
  // CRM-4 (docs/41) — schedulable daily follow-up digest: SLA-breached leads + overdue tasks + rotting deals
  // (detective control REV-22). Fires lead.stagnant into the automation engine + drops a rail notification.
  crm_followup_digest: { label: 'สรุปการติดตามงานขายประจำวัน', labelEn: 'CRM follow-up digest' },
  crm_account_health: { label: 'บันทึกสุขภาพบัญชีลูกค้า (churn watchlist)', labelEn: 'CRM account health snapshot' },
  // Likewise: each run advances every ACTIVE lifecycle journey — segment-entry sweeps + due steps (G1).
  journey_runner: { label: 'รันเจอร์นีย์ลูกค้า (Journeys)', labelEn: 'Run lifecycle journeys' },
  // An "action" job that rides the scheduler: each run executes the AR dunning sweep and reports a summary.
  // Create a `daily` subscription of this type to dun overdue customers automatically (idempotent per run).
  ar_collections_dunning: { label: 'ทวงถามหนี้อัตโนมัติ', labelEn: 'Automated AR dunning' },
  // Likewise: each run raises preventive-maintenance work orders for every due PM schedule (idempotent).
  eam_pm_generate: { label: 'สร้างใบสั่งงานซ่อมตามแผน (PM)', labelEn: 'Generate due preventive maintenance' },
  // Asset audit results (FA-11): recent audits + their found/missing/misplaced/unknown tallies + the
  // outstanding custody-change requests awaiting approval. Read-only aggregate.
  asset_audit: { label: 'ผลการตรวจนับทรัพย์สิน', labelEn: 'Asset audit results' },
  // FA-12 (detective): active assets not physically verified within N days (default 90) — an existence
  // exception list. Schedule it `monthly` so unverified assets surface for a count before period-end.
  asset_verification_exceptions: { label: 'ทรัพย์สินที่ไม่ได้ตรวจสอบเกินกำหนด', labelEn: 'Assets not verified in N days' },
  // Likewise: each run re-runs the 3-way match for every BLOCKED AP invoice (EXP-10) — a hold typically
  // clears itself once the outstanding GR posts, releasing the invoice to payment without a manual re-run.
  ap_automatch_rerun: { label: 'จับคู่ 3 ทางซ้ำอัตโนมัติ (ปลดล็อกใบแจ้งหนี้)', labelEn: 'Auto re-match blocked AP invoices' },
  // Likewise: each run posts every due recurring/template journal as a Draft JE (maker-checker, idempotent).
  gl_recurring_journals: { label: 'ลงรายการบัญชีตั้งเวลาอัตโนมัติ', labelEn: 'Post due recurring journals' },
  // LC-4 (docs/30) — LINE morning digest for {line_user} recipients: pending approvals + open PRs +
  // alert breaches over the last 24h. Delivery rides the normal recipient loop; scheduler dueness
  // (frequency 'daily') makes it once-per-day.
  line_daily_digest: { label: 'สรุปประจำวันทาง LINE', labelEn: 'LINE daily digest' },
  // D1 — proactive morning low-stock alert: pushes the reorder list (feature-C source: items.min_stock vs
  // inv_balances) to {line_user} recipients with a one-tap [สั่งเติมทั้งหมด] button. Read-only aggregate.
  low_stock_reorder_alert: { label: 'แจ้งเตือนสินค้าใกล้หมด (LINE)', labelEn: 'LINE low-stock reorder alert' },
  // D3 — purchase spend insights for a business month (total + top vendors + most-bought items). Read-only.
  purchase_spend: { label: 'สรุปยอดซื้อประจำเดือน', labelEn: 'Monthly purchase spend' },
  // Likewise: each run amortizes one period of every due prepaid schedule (Dr expense / Cr 1280, idempotent).
  gl_prepaid_amortize: { label: 'ตัดจ่ายค่าใช้จ่ายล่วงหน้า', labelEn: 'Amortize due prepaid expenses' },
  // FIN-7b (GL-23): each run posts one balanced Draft JE per due allocation cycle (Cr pool / Dr targets by
  // ratio·driver·statistical key, maker-checker, idempotent per period).
  gl_allocation_run: { label: 'ปันส่วนต้นทุนตามรอบ', labelEn: 'Run due GL allocation cycles' },
  // Likewise: each run posts one period of every due lease (interest + payment + ROU depreciation, idempotent).
  lease_periodic_run: { label: 'ลงรายการสัญญาเช่าประจำงวด', labelEn: 'Post due lease periods' },
  // HR-2 (docs/42, HR-02): each run credits one period of leave accrual per active employee (policy/grade/
  // tenure-driven), idempotent per (tenant, period) via leave_accrual_runs.
  hr_leave_accrual: { label: 'สะสมวันลาประจำงวด', labelEn: 'Run monthly leave accrual' },
  // HR-9 (docs/42 HCM depth, Wave 3, HR-09) — Workforce analytics: read-only aggregations over the HCM spine
  // (payroll.employees + hr_assignments/positions/departments + employee_lifecycle + pay_grades + leave_balances).
  // Each is idempotent (pure reads), schedulable and tenant-scoped; they feed the detective HR-09 workforce-
  // metrics review control.
  hr_headcount_trend: { label: 'กำลังคนตามแผนก/ตำแหน่ง/ช่วงเข้าทำงาน', labelEn: 'Workforce headcount by dept/position' },
  hr_turnover: { label: 'อัตราการลาออก (Turnover)', labelEn: 'Workforce turnover / attrition rate' },
  hr_tenure_distribution: { label: 'การกระจายอายุงานพนักงาน', labelEn: 'Employee tenure distribution' },
  hr_comp_ratio: { label: 'อัตราค่าตอบแทนเทียบกรอบเงินเดือน (Comp ratio)', labelEn: 'Compensation ratio vs pay-grade band' },
  hr_leave_liability: { label: 'ภาระวันลาสะสมคงค้าง', labelEn: 'Accrued leave liability' },
  apply_scheduled_master_changes: { label: 'ปรับข้อมูลหลักตามวันที่มีผล', labelEn: 'Apply date-effective master changes' },
  // Construction/real-estate sweeps (docs/35 Depth) — each idempotent: retention released on its schedule,
  // bookings expired past their date, overdue property installments surfaced.
  retention_release_due: { label: 'คืนเงินประกันผลงานที่ถึงกำหนด', labelEn: 'Release due retention' },
  re_booking_expire: { label: 'ยกเลิกการจองที่หมดอายุ', labelEn: 'Expire lapsed unit bookings' },
  re_installment_overdue: { label: 'งวดผ่อนอสังหาฯ ที่เกินกำหนด', labelEn: 'Overdue property installments' },
  nps_post_purchase: { label: 'ส่งแบบสอบถาม NPS หลังการขาย', labelEn: 'Send post-purchase NPS surveys' }, // W3 (docs/27)
  membership_revenue_recognize: { label: 'รับรู้รายได้ค่าสมาชิก VIP รายเดือน', labelEn: 'Recognize monthly VIP membership revenue' }, // V4 (docs/29)
  // Likewise: each run recognizes every due TFRS-15 revenue schedule through the current period (idempotent).
  rev_rec_recognize: { label: 'รับรู้รายได้ตามสัญญา (TFRS 15)', labelEn: 'Recognize due revenue schedules' },
  // Governance readiness (ELC-01/02/04): each run snapshots acknowledgement coverage, oversight cadence and
  // open-case ageing; the run summary surfaces any breach. Schedule it `weekly` to drive the cadence reminders.
  governance_readiness: { label: 'ความพร้อมธรรมาภิบาล (ELC)', labelEn: 'Governance readiness (ELC)' },
  // Data-retention purge of DEAD ephemeral security rows only (never financial/audit/PII — statutory hold).
  data_retention_purge: { label: 'ล้างข้อมูลชั่วคราวที่หมดอายุ (นโยบายเก็บข้อมูล)', labelEn: 'Purge expired ephemeral security rows' },
  // Executive cross-module scorecard (RG-1): composes finance/CRM/projects/supply-chain health into one board.
  exec_scorecard: { label: 'สรุปผู้บริหารข้ามโมดูล', labelEn: 'Executive cross-module scorecard' },
  // Budget-vs-actual variance (RG-2): wraps BudgetService.budgetVsActual (ELC-06) for the scheduler.
  budget_variance: { label: 'งบประมาณเทียบกับจริง', labelEn: 'Budget vs actual variance' },
  // Flux / variance analysis (CLS-01/GL-25): generates a period-over-period P&L flux and surfaces the
  // threshold-breaching lines that management must explain before close sign-off. Read-only.
  flux_analysis: { label: 'วิเคราะห์ผลต่าง (Flux) เพื่อสอบทานปิดงวด', labelEn: 'Flux / variance analysis' },
  // Supplier performance (RG-3): wraps the supplier scorecard compute (avg score + underperformers).
  supplier_scorecard: { label: 'คะแนนผลงานผู้ขาย', labelEn: 'Supplier performance scorecard' },
  // Action job: each run captures a dated EVM/RAG health snapshot for every project (idempotent per day).
  project_health_capture: { label: 'บันทึกสุขภาพโครงการ', labelEn: 'Capture project health snapshots' },
  project_governance_pack: { label: 'รายงานสถานะโครงการ (ธรรมาภิบาล)', labelEn: 'Project governance / status pack' },
  // Action job (monthly): each run bills every tenant's metered AI overage for the just-closed month as a
  // Stripe invoice item (idempotent per tenant+month). Connects the AI-COGS meter to actual collection.
  ai_overage_billing: { label: 'เรียกเก็บค่า AI ส่วนเกิน (รายเดือน)', labelEn: 'Bill AI usage overage (monthly)' },
  usage_overage_billing: { label: 'เรียกเก็บค่าใช้งานส่วนเกิน (e-Tax/POS รายเดือน)', labelEn: 'Bill usage overage (e-Tax/POS, monthly)' },
  pii_retention_sweep: { label: 'ลบล้างข้อมูลส่วนบุคคลที่พ้นระยะเก็บรักษา (PDPA)', labelEn: 'Anonymize PII past retention (PDPA)' },
  key_rotation_sweep: { label: 'หมุนกุญแจเข้ารหัสข้อมูล (re-encrypt)', labelEn: 'Rotate encryption key (re-encrypt at rest)' },
  // Action job (daily/weekly): each run pushes the tenant's member snapshot (identity + RFM + consent) to an
  // external CDP webhook in batches — idempotent (a full snapshot keyed by member_code) and consent-aware.
  cdp_export_sync: { label: 'ซิงก์ข้อมูลลูกค้าไป CDP', labelEn: 'Sync customer data to CDP' },
  // Tax automation (docs/33 PR4, TAX-03/TAX-05). Each run is idempotent per period.
  // Issue the 50-ทวิ certificate for every un-certificated AP-payment WHT (labour/service withholding).
  tax_wht_cert_batch: { label: 'ออกหนังสือรับรองหัก ณ ที่จ่าย (50 ทวิ) อัตโนมัติ', labelEn: 'Issue due WHT certificates (50-tawi)' },
  // Register the period's PP30 / PND filing as a DRAFT (a human submits to the RD).
  tax_pp30_draft: { label: 'จัดทำแบบ ภ.พ.30 (ฉบับร่าง)', labelEn: 'Draft PP30 VAT filing' },
  tax_pnd_draft: { label: 'จัดทำแบบ ภ.ง.ด.3/53 (ฉบับร่าง)', labelEn: 'Draft PND3/53 WHT filing' },
  // Remittance reminder: the period's amounts due + statutory deadlines (7th PND / 15th PP30).
  tax_remittance_reminder: { label: 'แจ้งเตือนกำหนดนำส่งภาษี', labelEn: 'Tax remittance reminder' },
  // Submission durability (docs/ops/etax-production-spike.md gap #5): retry every e-Tax submission whose
  // latest attempt isn't Accepted yet — idempotent, a fresh success or failure lands as a new attempt row.
  etax_submission_retry: { label: 'ลองส่ง e-Tax ที่ล้มเหลวซ้ำ', labelEn: 'Retry failed e-Tax submissions' },
  // docs/35 Phase 6 — schedulable finance analytics packs (wrap the FinanceMetricsService aggregators).
  // Each run recomputes the read-only board and delivers it (email/LINE/in-app) with an MD&A headline.
  cfo_kpi_pack: { label: 'สรุปตัวชี้วัด CFO + คำอธิบาย', labelEn: 'CFO KPI pack + narrative' },
  cash_position_pack: { label: 'สถานะเงินสด + พยากรณ์ 13 สัปดาห์', labelEn: 'Cash position + 13-week forecast' },
  close_status_pack: { label: 'ความพร้อมปิดงวดบัญชี', labelEn: 'Period-close readiness' },
};
export const FREQUENCIES = ['daily', 'weekly', 'monthly'] as const;
