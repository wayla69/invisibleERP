// LINE chat flex cards + the plain-text command usage — PURE presentation data/builders extracted from
// line-webhook.controller.ts (2026-07-09 decomposition; zero behaviour change — the strings are byte-
// identical, only relocated). No DB, no Nest — keep it that way.

export const CHAT_USAGE =
  'รูปแบบคำสั่ง:\n• pr <รหัสสินค้า> <จำนวน> [เหตุผล — ไม่ใส่ก็ได้] — สร้างคำขอซื้อ (หลายรายการคั่นด้วย , หรือขึ้นบรรทัดใหม่)\n• status <เลขที่ PR> — เช็คสถานะ · my prs — คำขอล่าสุดของฉัน · cancel <เลขที่ PR> — ถอนคำขอ\n• find <คำค้น> — ค้นหารหัสสินค้า · stock <รหัสสินค้า> — ดูยอดคงเหลือ · low — สินค้าใกล้หมด · reorder — เปิด PR เติมของทั้งหมด\n• บิล — เก็บบิล/ใบเสร็จส่งให้บัญชี (พิมพ์ บิล แล้วส่งรูปตามมา) · attach <เลขที่ PO> — แนบรูปใบแจ้งหนี้/ใบเสร็จ · receive <เลขที่ PO> [<รหัสสินค้า> <จำนวน>] — รับครบ/รับบางส่วน · claim <PO/GR> <จำนวน> [เหตุผล] — แจ้งของขาด/เสีย\n• expense/advance <กองทุน> <จำนวนเงิน> [เหตุผล] — เบิกเงินสดย่อย\n• leave <จากวันที่ YYYY-MM-DD> <จำนวนวัน> [เหตุผล] — ส่งใบลา · subscribe digest [kpi,…] — รับสรุปประจำวัน (digest kpis = ดู KPI ที่เลือกได้) · subscribe lowstock — แจ้งเตือนของใกล้หมดทุกเช้า\n• ask <คำถาม> — ถามยอดขาย (เช่น ask ยอดขายตามสาขา) · บอท <ข้อความ> — ให้ AI ร่างคำขอซื้อ (ยืนยันก่อนสร้างเสมอ) · spend [YYYY-MM] — สรุปยอดซื้อ\n• approve/reject <เลขที่ PR> — อนุมัติ/ปฏิเสธ (เฉพาะทีมจัดซื้อ)\nเช่น  pr A4-PAPER 10  (สั่งเฉย ๆ ไม่ต้องมีเหตุผล) · หลายรายการ  pr A4-PAPER 10, TONER-85A 2';

// LC-1 — approve/reject confirm bubble (postback carries the one-time nonce; 5-minute TTL).
export function confirmCard(action: 'approve' | 'reject', docNo: string, nonce: string): any {
  return {
    type: 'bubble',
    body: {
      type: 'box', layout: 'vertical', spacing: 'sm', contents: [
        { type: 'text', text: action === 'approve' ? 'ยืนยันการอนุมัติ?' : 'ยืนยันการปฏิเสธ?', weight: 'bold', size: 'md' },
        { type: 'text', text: docNo, weight: 'bold', size: 'lg' },
        { type: 'text', text: 'กดยืนยันภายใน 5 นาที', size: 'xs', color: '#888888' },
      ],
    },
    footer: {
      type: 'box', layout: 'horizontal', contents: [
        { type: 'button', style: action === 'approve' ? 'primary' : 'secondary', height: 'sm', action: { type: 'postback', label: 'ยืนยัน', data: JSON.stringify({ a: 'confirm', d: docNo, n: nonce }), displayText: `ยืนยัน ${docNo}` } },
      ],
    },
  };
}

// ── The command menu as a flex bubble (used by the link-welcome + the `help`/`เมนู` command). One data
// list drives both the flex card and CHAT_USAGE stays the plain-text altText/fallback. Grouped by cycle
// with an accent-coloured header per group + separators — readable on a phone instead of a text wall.
const CMD_GROUPS: Array<{ icon: string; title: string; color: string; items: Array<[string, string]> }> = [
  { icon: '🛒', title: 'คำขอซื้อ (PR)', color: '#2563eb', items: [
    ['pr <รหัสสินค้า> <จำนวน>', 'สร้างคำขอซื้อ — เหตุผลใส่หรือไม่ก็ได้ (หลายรายการคั่นด้วย ,)'],
    ['status <เลขที่ PR>', 'เช็คสถานะ'],
    ['my prs', 'คำขอล่าสุดของฉัน'],
    ['cancel <เลขที่ PR>', 'ถอนคำขอ'],
  ] },
  { icon: '🔎', title: 'ค้นหา & สต็อก', color: '#0891b2', items: [
    ['find <คำค้น>', 'ค้นหารหัสสินค้า'],
    ['stock <รหัสสินค้า>', 'ดูยอดคงเหลือ'],
    ['low', 'ดูสินค้าใกล้หมด (ต่ำกว่าจุดสั่งซื้อ)'],
    ['reorder', 'เปิด PR เติมของใกล้หมดทั้งหมดในครั้งเดียว'],
  ] },
  { icon: '💸', title: 'การเงิน & เอกสาร', color: '#059669', items: [
    ['expense/advance <กองทุน> <จำนวนเงิน> [เหตุผล]', 'เบิกเงินสดย่อย'],
    ['บิล → ส่งรูป', 'เก็บบิล/ใบเสร็จส่งให้บัญชีตรวจสอบ'],
    ['attach <เลขที่ PO>', 'แนบรูปใบแจ้งหนี้/ใบเสร็จ'],
    ['receive <เลขที่ PO>', 'รับของครบตาม PO'],
    ['receive <PO> <รหัสสินค้า> <จำนวน>', 'รับบางส่วน (เฉพาะรายการ/จำนวนที่ระบุ)'],
    ['claim <PO/GR> <จำนวน> [เหตุผล]', 'แจ้งของขาด/เสีย (เปิดเคลมกับผู้ขาย)'],
  ] },
  { icon: '📅', title: 'ลางาน', color: '#7c3aed', items: [
    ['leave <YYYY-MM-DD> <จำนวนวัน> [เหตุผล]', 'ส่งใบลา'],
  ] },
  { icon: '📊', title: 'รายงาน & AI', color: '#d97706', items: [
    ['subscribe digest [kpi,…]', 'รับสรุปประจำวัน (digest kpis = ดู KPI ที่เลือกได้)'],
    ['subscribe lowstock', 'รับแจ้งเตือนสินค้าใกล้หมดทุกเช้า + ปุ่มสั่งเติม'],
    ['ask <คำถาม>', 'ถามยอดขาย เช่น ask ยอดขายตามสาขา'],
    ['spend [YYYY-MM]', 'สรุปยอดซื้อเดือนนี้ — ผู้ขาย/สินค้าสูงสุด'],
    ['บอท <ข้อความ>', 'ให้ AI ช่วยร่าง (ยืนยันก่อนสร้างเสมอ)'],
  ] },
  { icon: '✅', title: 'อนุมัติ (เฉพาะทีมจัดซื้อ)', color: '#b45309', items: [
    ['approve/reject <เลขที่ PR>', 'อนุมัติ/ปฏิเสธ'],
  ] },
];

export function helpCard(headerTitle: string, subtitle: string): any {
  const groups = CMD_GROUPS.flatMap((g, gi) => [
    ...(gi > 0 ? [{ type: 'separator', margin: 'md' }] : []),
    { type: 'text', text: `${g.icon}  ${g.title}`, weight: 'bold', size: 'sm', color: g.color, margin: gi > 0 ? 'md' : 'none' },
    ...g.items.map(([cmd, desc]) => ({
      type: 'box', layout: 'vertical', spacing: 'none', margin: 'sm', contents: [
        { type: 'text', text: cmd, size: 'sm', weight: 'bold', color: '#1f2937', wrap: true },
        { type: 'text', text: desc, size: 'xs', color: '#9ca3af', wrap: true },
      ],
    })),
  ]);
  return {
    type: 'bubble',
    header: {
      type: 'box', layout: 'vertical', paddingAll: 'lg', backgroundColor: '#f0f7ff', contents: [
        { type: 'text', text: headerTitle, weight: 'bold', size: 'lg', color: '#1e3a8a', wrap: true },
        { type: 'text', text: subtitle, size: 'xs', color: '#6b7280', margin: 'xs', wrap: true },
      ],
    },
    body: { type: 'box', layout: 'vertical', spacing: 'none', paddingAll: 'lg', contents: groups },
    footer: {
      type: 'box', layout: 'vertical', paddingAll: 'md', contents: [
        { type: 'text', text: 'ตัวอย่าง:  pr A4-PAPER 10  (ไม่ต้องใส่เหตุผล) · หลายรายการ  pr A4-PAPER 10, TONER-85A 2', size: 'xs', color: '#9ca3af', wrap: true },
        { type: 'text', text: 'พิมพ์ "help" เพื่อเปิดเมนูนี้อีกครั้ง', size: 'xs', color: '#c0c4cc', margin: 'sm' },
      ],
    },
  };
}
