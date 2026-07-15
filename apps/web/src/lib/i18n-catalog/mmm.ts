import type { Lang } from '../messages';

// docs/48 — Marketing Mix Modeling workspace (/mmm). Namespaced `mmm.*` (+ the `nav.mmm` menu label).
export const CATALOG: Record<string, Partial<Record<Lang, string>>> = {
  'nav.mmm': { th: 'Marketing Mix (MMM)', en: 'Marketing Mix (MMM)' },

  'mmm.title': { th: 'Marketing Mix Modeling', en: 'Marketing Mix Modeling' },
  'mmm.subtitle': {
    th: 'ประเมิน ROI ต่อช่องทางการตลาดจากสัญญาณยอดขายและกระแสโซเชียล แล้วเสนอการจัดสรรงบประมาณที่เหมาะสม',
    en: 'Model channel ROI from sales + social signals, then recommend an optimal budget split',
  },

  'mmm.tab_ingest': { th: 'นำเข้าข้อมูล', en: 'Ingest' },
  'mmm.tab_signals': { th: 'สัญญาณ', en: 'Signals' },
  'mmm.tab_model': { th: 'รันโมเดล', en: 'Model' },
  'mmm.tab_rec': { th: 'คำแนะนำ', en: 'Recommendation' },

  // Ingest (manual data entry for a store without an ETL)
  'mmm.ing_hint': { th: 'ไม่มีระบบเชื่อมต่ออัตโนมัติ? กรอกยอดขายและกระแสโซเชียลรายวันที่นี่ — ข้อมูลจะไปอยู่ในแท็บสัญญาณและใช้รันโมเดลได้ทันที', en: 'No integration yet? Enter daily channel sales + sentiment here — they land in the Signals tab and feed the model immediately.' },
  'mmm.ing_sales': { th: 'ยอดขายตามช่องทาง', en: 'Channel sales' },
  'mmm.ing_sentiment': { th: 'กระแสโซเชียล', en: 'Social sentiment' },
  'mmm.ing_add_row': { th: 'เพิ่มแถว', en: 'Add row' },
  'mmm.ing_submit': { th: 'นำเข้า', en: 'Ingest' },
  'mmm.ing_done': { th: 'นำเข้า {{n}} แถวแล้ว', en: 'Ingested {{n}} row(s)' },
  'mmm.ing_need_row': { th: 'กรอกอย่างน้อยหนึ่งแถวให้ครบ (วันที่ + ช่องทาง + ค่าตัวเลข)', en: 'Fill at least one complete row (date + channel + value)' },
  'mmm.ing_sentiment_ph': { th: 'คะแนน -1..1', en: 'score -1..1' },

  // Run drill-down
  'mmm.runs_hint': { th: 'คลิกที่รายการเพื่อดูผลรายช่องทางของการรันนั้น', en: 'Click a run to see its per-channel results' },
  'mmm.run_detail': { th: 'ผลการรัน', en: 'Run detail' },

  // Signals
  'mmm.sales_by_channel': { th: 'ยอดขายตามช่องทาง (30 วัน)', en: 'Sales by channel (30 days)' },
  'mmm.sentiment_by_platform': { th: 'กระแสโซเชียลตามแพลตฟอร์ม (30 วัน)', en: 'Sentiment by platform (30 days)' },
  'mmm.no_signals': { th: 'ยังไม่มีสัญญาณที่นำเข้า', en: 'No ingested signals yet' },
  'mmm.col_channel': { th: 'ช่องทาง', en: 'Channel' },
  'mmm.col_revenue': { th: 'รายได้', en: 'Revenue' },
  'mmm.col_units': { th: 'จำนวน', en: 'Units' },
  'mmm.col_platform': { th: 'แพลตฟอร์ม', en: 'Platform' },
  'mmm.col_mentions': { th: 'การกล่าวถึง', en: 'Mentions' },
  'mmm.col_avg_sentiment': { th: 'คะแนนเฉลี่ย', en: 'Avg sentiment' },

  // Model
  'mmm.run_title': { th: 'รันโมเดลการตลาด', en: 'Run the model' },
  'mmm.window_days': { th: 'ช่วงเวลา (วัน)', en: 'Window (days)' },
  'mmm.spend_by_channel': { th: 'งบประมาณต่อช่องทาง', en: 'Spend by channel' },
  'mmm.ph_channel': { th: 'ช่องทาง (เช่น facebook)', en: 'channel (e.g. facebook)' },
  'mmm.ph_spend': { th: 'งบ (บาท)', en: 'spend (THB)' },
  'mmm.add_channel': { th: 'เพิ่มช่องทาง', en: 'Add channel' },
  'mmm.remove': { th: 'ลบ', en: 'Remove' },
  'mmm.run': { th: 'รันโมเดล', en: 'Run model' },
  'mmm.run_done': { th: 'รันโมเดลสำเร็จ ({{runNo}}) — {{n}} ช่องทาง', en: 'Model run complete ({{runNo}}) — {{n}} channels' },
  'mmm.no_runs': { th: 'ยังไม่มีการรันโมเดล', en: 'No model runs yet' },
  'mmm.col_run_no': { th: 'รหัสการรัน', en: 'Run' },
  'mmm.col_window': { th: 'ช่วงเวลา', en: 'Window' },
  'mmm.col_total_spend': { th: 'งบรวม', en: 'Total spend' },
  'mmm.col_run_by': { th: 'รันโดย', en: 'Run by' },
  'mmm.col_run_at': { th: 'เวลา', en: 'When' },

  // Recommendation
  'mmm.no_run_yet': { th: 'ยังไม่มีผลการรัน — ไปที่แท็บ “รันโมเดล” เพื่อเริ่ม', en: 'No run yet — use the Model tab to run one' },
  'mmm.kpi_run': { th: 'การรันล่าสุด', en: 'Latest run' },
  'mmm.kpi_total_spend': { th: 'งบรวม', en: 'Total spend' },
  'mmm.kpi_channels': { th: 'ช่องทาง', en: 'Channels' },
  'mmm.kpi_top_channel': { th: 'ช่องทางเด่น', en: 'Top channel' },
  'mmm.rec_title': { th: 'ROI ต่อช่องทาง + งบที่แนะนำ', en: 'Per-channel ROI + recommended budget' },
  'mmm.no_results': { th: 'ไม่มีผลลัพธ์', en: 'No results' },
  'mmm.col_spend': { th: 'งบที่ใช้', en: 'Spend' },
  'mmm.col_attr_revenue': { th: 'รายได้ที่ระบุ', en: 'Attributed rev.' },
  'mmm.col_roi': { th: 'ROI', en: 'ROI' },
  'mmm.col_lift': { th: 'สัดส่วนผลลัพธ์', en: 'Lift share' },
  'mmm.col_optimal': { th: 'งบที่แนะนำ', en: 'Optimal budget' },
};
