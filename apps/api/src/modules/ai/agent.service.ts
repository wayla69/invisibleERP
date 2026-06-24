import { Injectable, Optional, ServiceUnavailableException } from '@nestjs/common';
import { PosService } from '../pos/pos.service';
import { InventoryService } from '../inventory/inventory.service';
import { FinanceService } from '../finance/finance.service';
import { CashflowService } from '../finance/cashflow.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { BiService } from '../bi/bi.service';
import { PipelineService } from '../pipeline/pipeline.service';
import { CpqService } from '../cpq/cpq.service';
import { ServiceService } from '../service/service.service';
import { ProfitabilityService } from '../profitability/profitability.service';
import { AiActionService } from './ai-action.service';
import { KnowledgeService } from './knowledge.service';
import { MenuEngineeringService } from '../analytics/menu-engineering.service';
import { ProductionPlanService } from '../menu/production-plan.service';
import { RecipeService } from '../menu/recipe.service';
import { MarketingAutomationService } from '../marketing/marketing-automation.service';
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
- เตือนทันทีเมื่อพบสต๊อกต่ำหรือใบแจ้งหนี้เกินกำหนด
- การกระทำที่เปลี่ยนข้อมูล (ลงบัญชี/สั่งซื้อ) ให้ "เสนอ" ผ่าน tool propose_* เท่านั้น ห้ามอ้างว่าทำสำเร็จแล้ว — ต้องแจ้งผู้ใช้ว่ารอผู้มีสิทธิ์อนุมัติ (และผู้อนุมัติต้องไม่ใช่ผู้เสนอ)
- คำถามเชิงนโยบาย/ขั้นตอน/สัญญา ให้ใช้ search_knowledge_base แล้วตอบ "เฉพาะจากผลลัพธ์ที่ค้นได้" พร้อมอ้างชื่อเอกสาร ถ้าไม่พบข้อมูลที่เกี่ยวข้องให้บอกตรง ๆ ว่าไม่พบ — ห้ามเดา (cite-or-refuse)`;

const TOOLS = [
  { name: 'get_sales_summary', description: 'สรุปยอดขาย POS ในช่วงวันที่', input_schema: { type: 'object', properties: { start_date: { type: 'string' }, end_date: { type: 'string' } }, required: ['start_date', 'end_date'] } },
  { name: 'get_recent_orders', description: 'ออเดอร์ล่าสุด', input_schema: { type: 'object', properties: { limit: { type: 'number' } } } },
  { name: 'get_stock_levels', description: 'ระดับสต๊อกสินค้า (search, below_reorder_only)', input_schema: { type: 'object', properties: { search: { type: 'string' }, below_reorder_only: { type: 'boolean' }, limit: { type: 'number' } } } },
  { name: 'get_stock_item', description: 'รายละเอียดสต๊อกของสินค้า 1 รายการ', input_schema: { type: 'object', properties: { item_id: { type: 'string' } }, required: ['item_id'] } },
  { name: 'get_pl_summary', description: 'สรุป P&L รายเดือน', input_schema: { type: 'object', properties: { month: { type: 'number' }, year: { type: 'number' } }, required: ['month', 'year'] } },
  { name: 'get_kpi_dashboard', description: 'KPI การเงิน (MTD/YTD, AR/AP)', input_schema: { type: 'object', properties: {} } },
  { name: 'get_accounts_payable', description: 'รายการเจ้าหนี้ค้างชำระ', input_schema: { type: 'object', properties: {} } },
  { name: 'get_replenishment_list', description: 'รายการสินค้าที่ควรสั่งซื้อ (forecast)', input_schema: { type: 'object', properties: { limit: { type: 'number' } } } },
  // Phase 20 — BI
  { name: 'get_kpi_board', description: 'KPI board รวม: ยอดขาย MTD/YTD, AR/AP, pipeline (real-time)', input_schema: { type: 'object', properties: {} } },
  { name: 'get_sales_cube', description: 'วิเคราะห์ยอดขายตามช่วงเวลา (day/week/month)', input_schema: { type: 'object', properties: { period: { type: 'string', enum: ['day','week','month'] }, months: { type: 'number' } } } },
  { name: 'get_finance_trend', description: 'แนวโน้ม P&L รายเดือน (revenue/expense/gross profit)', input_schema: { type: 'object', properties: { months: { type: 'number' } } } },
  // Phase 20 — Pipeline
  { name: 'get_pipeline_forecast', description: 'พยากรณ์ sales pipeline แบ่งตาม stage + weighted value', input_schema: { type: 'object', properties: {} } },
  { name: 'list_open_opportunities', description: 'รายการ opportunity ที่ยังเปิดอยู่', input_schema: { type: 'object', properties: { limit: { type: 'number' } } } },
  // Phase 20 — CPQ
  { name: 'get_open_quotes', description: 'ใบเสนอราคาที่รอการตอบรับ (Sent)', input_schema: { type: 'object', properties: {} } },
  // Phase 20 — Service
  { name: 'get_sla_breaches', description: 'SLA event ที่ถูก breach (response หรือ resolution เกินกำหนด)', input_schema: { type: 'object', properties: {} } },
  // Phase 20 — Profitability
  { name: 'get_profitability_report', description: 'รายงาน contribution margin ต่อ segment', input_schema: { type: 'object', properties: { run_id: { type: 'number' } } } },
  // Phase D1 — agentic WRITE-ops. These do NOT execute; they FILE a proposal that a different
  // authorized human must approve. Always tell the user the action is pending approval.
  { name: 'propose_journal_entry', description: 'เสนอรายการบัญชี (journal entry) เพื่อให้ผู้มีสิทธิ์อนุมัติ — ไม่โพสต์ทันที. ต้องสมดุล (เดบิต=เครดิต).', input_schema: { type: 'object', properties: { memo: { type: 'string' }, rationale: { type: 'string' }, lines: { type: 'array', items: { type: 'object', properties: { account_code: { type: 'string' }, debit: { type: 'number' }, credit: { type: 'number' } }, required: ['account_code'] } } }, required: ['lines'] } },
  { name: 'propose_purchase_order', description: 'เสนอใบสั่งซื้อ (PO) เพื่อให้ผู้มีสิทธิ์อนุมัติ — ไม่สร้างทันที.', input_schema: { type: 'object', properties: { vendor_name: { type: 'string' }, rationale: { type: 'string' }, items: { type: 'array', items: { type: 'object', properties: { item_id: { type: 'string' }, order_qty: { type: 'number' }, unit_price: { type: 'number' } }, required: ['item_id', 'order_qty', 'unit_price'] } } }, required: ['items'] } },
  // Phase D2 — RAG. Retrieve relevant passages from the company's policies/SOPs/contracts. Answer
  // policy questions ONLY from these results; cite the title; if nothing relevant returns, say so.
  { name: 'search_knowledge_base', description: 'ค้นหานโยบาย/ขั้นตอนปฏิบัติ/สัญญา ในฐานความรู้ของบริษัท เพื่อตอบคำถามเชิงนโยบายโดยอ้างอิงแหล่งที่มา', input_schema: { type: 'object', properties: { query: { type: 'string' }, k: { type: 'number' } }, required: ['query'] } },
  // Restaurant F&B — conversational analytics at the till (date windows default to today; YYYY-MM-DD).
  { name: 'get_production_plan', description: 'แผนเตรียมครัววันนี้/ล่วงหน้า: พยากรณ์ยอดขายแต่ละเมนู (ตามวันในสัปดาห์) → จำนวนที่ควรเตรียม + วัตถุดิบที่ควรสั่งซื้อ', input_schema: { type: 'object', properties: { days: { type: 'number' }, lookback: { type: 'number' } } } },
  { name: 'get_menu_engineering', description: 'จัดกลุ่มเมนูตามความนิยม×กำไร (Star/Plowhorse/Puzzle/Dog) พร้อมคำแนะนำ', input_schema: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } } } },
  { name: 'get_daypart_sales', description: 'ยอดขายตามช่วงเวลา/ชั่วโมงของวัน (เวลาไทย) — หาช่วงพีก', input_schema: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } } } },
  { name: 'get_void_discount_report', description: 'รายงานการยกเลิก/ส่วนลด: อัตรายกเลิก แยกตามเหตุผล/พนักงาน', input_schema: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } } } },
  { name: 'get_staff_performance', description: 'ผลงานพนักงาน: ยอดขาย/บิลเฉลี่ย/การยกเลิก-ส่วนลด ต่อคน', input_schema: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } } } },
  { name: 'get_sales_trend', description: 'แนวโน้มยอดขายเทียบช่วงก่อนหน้าที่เท่ากัน (เพิ่ม/ลด %)', input_schema: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } } } },
  { name: 'get_menu_availability', description: 'เมนูแต่ละอย่างทำได้อีกกี่จาน (จากวัตถุดิบที่จำกัด) + วัตถุดิบใกล้หมด', input_schema: { type: 'object', properties: { low: { type: 'number' } } } },
  { name: 'get_cashflow_forecast', description: 'พยากรณ์กระแสเงินสดรายสัปดาห์ (เงินสดตั้งต้น+ลูกหนี้+เจ้าหนี้+ยอดขาย) เตือนเงินสดขาดมือ + คะแนนสุขภาพการเงิน', input_schema: { type: 'object', properties: { weeks: { type: 'number' } } } },
  { name: 'get_marketing_audience', description: 'จำนวนลูกค้าเป้าหมายของแคมเปญ (lapsed=ห่างหาย, birthday=วันเกิด, winback=กลุ่มเสี่ยง/หาย) ที่ส่งถึงได้ — ดูอย่างเดียว ไม่ส่ง', input_schema: { type: 'object', properties: { trigger: { type: 'string', enum: ['lapsed', 'birthday', 'winback', 'all'] }, channel: { type: 'string' }, lapsed_days: { type: 'number' } }, required: ['trigger'] } },
];

@Injectable()
export class AgentService {
  constructor(
    private readonly pos: PosService,
    private readonly inv: InventoryService,
    private readonly fin: FinanceService,
    private readonly analytics: AnalyticsService,
    @Optional() private readonly bi: BiService,
    @Optional() private readonly pipeline: PipelineService,
    @Optional() private readonly cpq: CpqService,
    @Optional() private readonly svc: ServiceService,
    @Optional() private readonly profitability: ProfitabilityService,
    @Optional() private readonly actions: AiActionService,
    @Optional() private readonly knowledge: KnowledgeService,
    @Optional() private readonly menuEng?: MenuEngineeringService,
    @Optional() private readonly production?: ProductionPlanService,
    @Optional() private readonly recipe?: RecipeService,
    @Optional() private readonly cashflow?: CashflowService,
    @Optional() private readonly marketing?: MarketingAutomationService,
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
            const out = await this.exec(block.name, block.input, _user);
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

  // ── SSE streaming ─────────────────────────────────────────────────────────
  // async generator: รัน tool-loop เดิม แต่ assistant turn สุดท้ายใช้ Anthropic
  // streaming แล้ว yield text deltas ทีละชิ้น → controller map เป็น SSE MessageEvent
  // event shape: { delta: string }  (ระหว่างพิมพ์)  |  { done: true, reply: string }
  async *stream(
    message: string,
    history: any[] = [],
    _user: JwtUser,
  ): AsyncGenerator<{ delta?: string; done?: boolean; reply?: string; error?: string }> {
    if (!this.apiKey) {
      // ไม่มี API key → ไม่ 503 ทั้ง stream แต่ส่งข้อความไทยแจ้งเตือนแล้วจบ
      const note = 'ระบบ AI ยังไม่พร้อมใช้งาน (ยังไม่ได้ตั้งค่า ANTHROPIC_API_KEY) กรุณาติดต่อผู้ดูแลระบบ';
      yield { delta: note };
      yield { done: true, reply: note };
      return;
    }

    const Anthropic = require('@anthropic-ai/sdk').default ?? require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: this.apiKey });
    const messages: any[] = [...history.slice(-MAX_HISTORY), { role: 'user', content: message }];

    let reply = THAI_FALLBACK;
    try {
      for (let turn = 0; turn < MAX_LOOP_TURNS; turn++) {
        const isLast = turn === MAX_LOOP_TURNS - 1;
        const streamed = client.messages.stream({
          model: this.model,
          max_tokens: 4096,
          system: SYSTEM_TH,
          tools: TOOLS,
          messages,
        });

        // forward text deltas ทันทีระหว่างที่โมเดลกำลังพิมพ์ (async-iterator = ตามจังหวะจริง)
        for await (const ev of streamed as AsyncIterable<any>) {
          if (ev?.type === 'content_block_delta' && ev?.delta?.type === 'text_delta' && ev.delta.text) {
            yield { delta: ev.delta.text };
          }
        }

        const final = await streamed.finalMessage();
        messages.push({ role: 'assistant', content: final.content });

        const textOut = (final.content as any[])
          .filter((b) => b.type === 'text')
          .map((b) => b.text)
          .join('\n');

        if (final.stop_reason === 'end_turn' || isLast) {
          reply = textOut || reply;
          break;
        }

        // มี tool_use → รัน tool แล้วป้อนผลกลับเข้า loop
        const toolResults: any[] = [];
        for (const block of final.content as any[]) {
          if (block.type === 'tool_use') {
            const out = await this.exec(block.name, block.input, _user);
            toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(out) });
          }
        }
        if (toolResults.length) messages.push({ role: 'user', content: toolResults });
        else { reply = textOut || reply; break; }
      }
    } catch (e: any) {
      if (e?.constructor?.name === 'AuthenticationError') {
        const msg = '⚠️ AI authentication ล้มเหลว — ANTHROPIC_API_KEY ไม่ถูกต้อง';
        yield { delta: msg };
        yield { done: true, reply: msg, error: 'AUTH' };
        return;
      }
      const msg = `⚠️ ${e?.message ?? 'Unexpected error'}`;
      yield { delta: msg };
      yield { done: true, reply: msg, error: 'STREAM_ERROR' };
      return;
    }

    yield { done: true, reply };
  }

  private async exec(name: string, input: any, _user?: JwtUser): Promise<any> {
    const user = _user as JwtUser;
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
        // Phase 20 tools
        case 'get_kpi_board': return this.bi ? await this.bi.kpiBoard(user) : { error: 'BI module unavailable' };
        case 'get_sales_cube': return this.bi ? await this.bi.salesCube({ period: input.period ?? 'month', months: input.months ?? 3 }, user) : { error: 'BI module unavailable' };
        case 'get_finance_trend': return this.bi ? await this.bi.financeTrend({ months: input.months ?? 6 }, user) : { error: 'BI module unavailable' };
        case 'get_pipeline_forecast': return this.pipeline ? await this.pipeline.forecast(user) : { error: 'Pipeline module unavailable' };
        case 'list_open_opportunities': { const r = this.pipeline ? await this.pipeline.listOpportunities({ status: 'Open' }, user) : { opportunities: [], count: 0 }; return { ...r, opportunities: (r as any).opportunities?.slice(0, input.limit ?? 10) }; }
        case 'get_open_quotes': return this.cpq ? await this.cpq.listQuotes({ status: 'Sent' }, user) : { error: 'CPQ module unavailable' };
        case 'get_sla_breaches': {
          if (!this.svc) return { error: 'Service module unavailable' };
          const contracts = await this.svc.listContracts(user);
          const breaches: any[] = [];
          for (const c of (contracts as any).contracts ?? []) {
            const evts = await this.svc.listEvents(c.id);
            for (const e of (evts as any).events ?? []) {
              if (e.response_breached || e.resolution_breached) breaches.push({ contract: c.contract_no, ...e });
            }
          }
          return { breaches, count: breaches.length };
        }
        case 'get_profitability_report': return this.profitability ? await this.profitability.profitabilityReport({ period: input.period, segment_type: input.segment_type }, user) : { error: 'Profitability module unavailable' };
        // Phase D1 — propose write-ops (never execute; file a PENDING request for human approval)
        case 'propose_journal_entry': return this.actions ? await this.actions.propose({ kind: 'journal_entry', payload: { memo: input.memo, lines: input.lines }, rationale: input.rationale, source: 'ai' }, user) : { error: 'AI actions unavailable' };
        case 'propose_purchase_order': return this.actions ? await this.actions.propose({ kind: 'purchase_order', payload: { vendor_name: input.vendor_name, items: input.items }, rationale: input.rationale, source: 'ai' }, user) : { error: 'AI actions unavailable' };
        case 'search_knowledge_base': return this.knowledge ? await this.knowledge.search(input.query, input.k ?? 4, user) : { error: 'Knowledge base unavailable' };
        // Restaurant F&B — conversational analytics
        case 'get_production_plan': return this.production ? await this.production.plan(user, { days: input.days, lookback: input.lookback }) : { error: 'Production plan unavailable' };
        case 'get_menu_engineering': return this.menuEng ? await this.menuEng.menuEngineering(user, { from: input.from, to: input.to }) : { error: 'Analytics unavailable' };
        case 'get_daypart_sales': return this.menuEng ? await this.menuEng.daypart(user, { from: input.from, to: input.to }) : { error: 'Analytics unavailable' };
        case 'get_void_discount_report': return this.menuEng ? await this.menuEng.voidsDiscounts(user, { from: input.from, to: input.to }) : { error: 'Analytics unavailable' };
        case 'get_staff_performance': return this.menuEng ? await this.menuEng.staffPerformance(user, { from: input.from, to: input.to }) : { error: 'Analytics unavailable' };
        case 'get_sales_trend': return this.menuEng ? await this.menuEng.salesTrend(user, { from: input.from, to: input.to }) : { error: 'Analytics unavailable' };
        case 'get_menu_availability': return this.recipe ? await this.recipe.availabilityForecast(user, { low: input.low }) : { error: 'Menu availability unavailable' };
        case 'get_cashflow_forecast': return this.cashflow ? await this.cashflow.forecast(user, { weeks: input.weeks }) : { error: 'Cash-flow forecast unavailable' };
        case 'get_marketing_audience': return this.marketing ? await this.marketing.preview({ trigger: input.trigger, channel: input.channel, lapsed_days: input.lapsed_days }, user) : { error: 'Marketing automation unavailable' };
        default: return { error: `unknown tool ${name}` };
      }
    } catch (e: any) {
      return { error: String(e?.message ?? e) };
    }
  }
}
