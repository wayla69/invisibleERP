import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { PosService } from '../pos/pos.service';
import { InventoryService } from '../inventory/inventory.service';
import { FinanceService } from '../finance/finance.service';
import { AnalyticsService } from '../analytics/analytics.service';
import type { JwtUser } from '../../common/decorators';

// port จาก agents/base_agent.py + erp_agent.py
const MAX_LOOP_TURNS = 15;
const MAX_HISTORY = 40;
const THAI_FALLBACK = 'ขออภัย ไม่สามารถประมวลผลได้ในขณะนี้ กรุณาลองใหม่อีกครั้ง';
const SYSTEM_TH = `คุณคือ AI Assistant ของ Invisible ERP สำหรับ Oshinei Enterprise
- ตอบเป็นภาษาเดียวกับผู้ใช้ (ไทยหรืออังกฤษ)
- แสดงตัวเลขพร้อมคอมมาคั่นหลักพัน และหน่วยเป็น THB
- ใช้ tool ดึงข้อมูลจริงก่อนตอบเสมอ
- กระชับ เน้น insight ที่เป็นประโยชน์
- เตือนทันทีเมื่อพบสต๊อกต่ำหรือใบแจ้งหนี้เกินกำหนด`;

const TOOLS = [
  { name: 'get_sales_summary', description: 'สรุปยอดขาย POS ในช่วงวันที่', input_schema: { type: 'object', properties: { start_date: { type: 'string' }, end_date: { type: 'string' } }, required: ['start_date', 'end_date'] } },
  { name: 'get_recent_orders', description: 'ออเดอร์ล่าสุด', input_schema: { type: 'object', properties: { limit: { type: 'number' } } } },
  { name: 'get_stock_levels', description: 'ระดับสต๊อกสินค้า (search, below_reorder_only)', input_schema: { type: 'object', properties: { search: { type: 'string' }, below_reorder_only: { type: 'boolean' }, limit: { type: 'number' } } } },
  { name: 'get_stock_item', description: 'รายละเอียดสต๊อกของสินค้า 1 รายการ', input_schema: { type: 'object', properties: { item_id: { type: 'string' } }, required: ['item_id'] } },
  { name: 'get_pl_summary', description: 'สรุป P&L รายเดือน', input_schema: { type: 'object', properties: { month: { type: 'number' }, year: { type: 'number' } }, required: ['month', 'year'] } },
  { name: 'get_kpi_dashboard', description: 'KPI การเงิน (MTD/YTD, AR/AP)', input_schema: { type: 'object', properties: {} } },
  { name: 'get_accounts_payable', description: 'รายการเจ้าหนี้ค้างชำระ', input_schema: { type: 'object', properties: {} } },
  { name: 'get_replenishment_list', description: 'รายการสินค้าที่ควรสั่งซื้อ (forecast)', input_schema: { type: 'object', properties: { limit: { type: 'number' } } } },
];

@Injectable()
export class AgentService {
  constructor(
    private readonly pos: PosService,
    private readonly inv: InventoryService,
    private readonly fin: FinanceService,
    private readonly analytics: AnalyticsService,
  ) {}

  private get apiKey() { return process.env.ANTHROPIC_API_KEY || ''; }
  private get model() { return process.env.ANTHROPIC_MODEL || 'claude-opus-4-8'; }

  async chat(message: string, history: any[] = [], _user: JwtUser): Promise<{ reply: string; history: any[] }> {
    if (!this.apiKey)
      throw new ServiceUnavailableException({ code: 'AI_UNAVAILABLE', message: 'ANTHROPIC_API_KEY not set', messageTh: 'ยังไม่ได้ตั้งค่า AI (ANTHROPIC_API_KEY)' });

    const Anthropic = require('@anthropic-ai/sdk').default ?? require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: this.apiKey });
    const messages: any[] = [...history.slice(-MAX_HISTORY), { role: 'user', content: message }];

    let reply = THAI_FALLBACK;
    try {
      for (let turn = 0; turn < MAX_LOOP_TURNS; turn++) {
        const res = await client.messages.create({ model: this.model, max_tokens: 4096, system: SYSTEM_TH, tools: TOOLS, messages });
        messages.push({ role: 'assistant', content: res.content });
        if (res.stop_reason === 'end_turn') {
          reply = (res.content as any[]).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
          break;
        }
        const toolResults: any[] = [];
        for (const block of res.content as any[]) {
          if (block.type === 'tool_use') {
            const out = await this.exec(block.name, block.input);
            toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(out) });
          }
        }
        if (toolResults.length) messages.push({ role: 'user', content: toolResults });
        else break;
      }
    } catch (e: any) {
      if (e?.constructor?.name === 'AuthenticationError') throw e; // re-raise (UI ขอ key ใหม่)
      reply = `⚠️ ${e?.message ?? 'Unexpected error'}`;
    }

    const out = [...messages, { role: 'assistant', content: reply }].slice(-MAX_HISTORY);
    return { reply, history: out };
  }

  private async exec(name: string, input: any): Promise<any> {
    try {
      switch (name) {
        case 'get_sales_summary': return await this.pos.summary(input.start_date, input.end_date);
        case 'get_recent_orders': return await this.pos.orders(input.limit ?? 10, 0);
        case 'get_stock_levels': return await this.inv.getStock({ search: input.search, low_only: !!input.below_reorder_only, limit: input.limit ?? 50 } as any);
        case 'get_stock_item': return await this.inv.getStockDetail(input.item_id);
        case 'get_pl_summary': return await this.fin.pl(input.month, input.year);
        case 'get_kpi_dashboard': return await this.fin.kpi();
        case 'get_accounts_payable': return await this.fin.ap('Unpaid', 50, 0);
        case 'get_replenishment_list': return await this.analytics.replenishmentList(input.limit ?? 10);
        default: return { error: `unknown tool ${name}` };
      }
    } catch (e: any) {
      return { error: String(e?.message ?? e) };
    }
  }
}
