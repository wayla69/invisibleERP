# 06 — AI & Analytics Integration

พอร์ตสมอง AI ของระบบ (Anthropic Claude) จาก Python `agents/` + `analytics/` → TypeScript ใน NestJS module `ai` โดยคงพฤติกรรมเป๊ะ และยกระดับ (streaming, tools จริง, prompt caching)

**SDK:** `@anthropic-ai/sdk` (พอร์ตตรงจาก `base_agent.py` ReAct loop)

---

## 1. Agent loop (พอร์ต `BaseAgent`)

```ts
// modules/ai/agent.service.ts
@Injectable()
export class AgentService {
  private readonly MAX_LOOP_TURNS = 15;     // คงเดิม
  private readonly MAX_HISTORY = 40;        // คงเดิม
  private readonly model = process.env.ANTHROPIC_MODEL ?? 'claude-opus-4-8';  // centralize (เดิม mix opus-4-5/sonnet-4-6)

  async run(userMsg: string, history: Msg[], ctx: { user: JwtUser }): Promise<{reply: string; history: Msg[]}> {
    let messages = [...history, { role:'user', content: userMsg }];
    for (let turn = 0; turn < this.MAX_LOOP_TURNS; turn++) {
      const res = await this.client.messages.create({
        model: this.model, max_tokens: 4096,
        system: SYSTEM_PROMPT_TH,            // Thai system prompt (คงเดิม)
        tools: this.toolSchemas(ctx.user),   // กรองตาม RBAC
        messages,
      });
      messages.push({ role:'assistant', content: res.content });
      if (res.stop_reason === 'end_turn')
        return this.finish(messages, textOf(res));
      const toolResults = [];
      for (const block of res.content) {
        if (block.type === 'tool_use') {
          const out = await this.exec(block.name, block.input, ctx);  // เรียก service layer เดียวกับ REST
          toolResults.push({ type:'tool_result', tool_use_id: block.id, content: out });
        }
      }
      if (toolResults.length) messages.push({ role:'user', content: toolResults });
      else break;
    }
    return this.finish(messages, 'ขออภัย ไม่สามารถประมวลผลได้ในขณะนี้ กรุณาลองใหม่อีกครั้ง'); // Thai fallback (คงเดิม)
  }
}
```

**Parity ที่ต้องคง (จาก reverse-engineering):**
- `MAX_LOOP_TURNS=15`, `MAX_HISTORY=40`, `max_tokens=4096`
- **Thai system prompt** + **Thai loop-exhaustion fallback string**
- error handling: `AuthenticationError` → **re-throw** (UI ขอ key ใหม่); rate limit/API error → คืนสตริง `⚠️ ...`
- JSON tool output `ensure_ascii=false` equivalent (UTF-8 ไทยไม่เพี้ยน)
- ระบบ prompt rules: ใช้ tool ดึงข้อมูลจริงก่อนตอบ, ตัวเลข + คอมมา + THB, ยืนยันก่อนสร้าง PO, เตือน low stock/overdue ทันที

---

## 2. Tools = service layer เดียวกับ REST (สำคัญ)

แต่ละ AI tool เป็น **provider บางที่เรียก Service เดียวกับ REST endpoint** → agent กับคนใช้ code path เดียว → **ได้ RBAC + tenant scope อัตโนมัติ** (เดิม MCP/agent ไม่มี auth เลย — V2 ปิดช่องนี้)

| tool (19) | เรียก service | parity |
|---|---|---|
| get_sales_summary, get_recent_orders, get_order_detail, get_open_sessions | `PosService` | Voided excl; branch cosmetic |
| **void_order** | `PosService.void` | เฉพาะ user ที่มีสิทธิ์ (เดิม POSAgent only) |
| get_stock_levels, get_stock_item, get_supplier_list, get_purchase_orders | `InventoryService` | snapshot MAX(generate_date); supplier fallback |
| create_purchase_order | `ProcurementService.createPo` | PO no; ยืนยันก่อนสร้าง |
| **adjust_stock** | `InventoryService.adjust` | เฉพาะสิทธิ์ (เดิม InventoryAgent only); ADJ- |
| get_pl_summary, get_kpi_dashboard, get_cash_position, get_accounts_payable, get_accounts_receivable | `FinanceService` | revenue-only + `note`; Dec boundary |
| get_available_reports, generate_daily_report, generate_monthly_pl, generate_stock_report | `ReportsService` | Excel `#1E3C72` |

**RBAC tool gating** — `void_order`/`adjust_stock` ต้อง **ไม่** อยู่ใน toolset ของ general assistant (เดิมตั้งใจกัน privilege escalation) → กรอง `toolSchemas(user)` ตาม permission

---

## 3. Analytics (พอร์ต `analytics/` — ค่าคงที่เป๊ะ)

ย้าย deterministic math เป็น TS (อย่าใช้ LLM คำนวณ); LLM ใช้แค่ narrative layer

### Forecasting (`forecasting.ts`)
- `_dailySales(itemId, days=60)` — gap-fill series จาก **first sale date** (ไม่ใช่ now-60); Voided excl
- `_leadTimeDays` — mean(GR-PO) สูงสุด 10 PO, fallback **7.0**
- `predictStockout` — `recent = series[-30:]`; `avg=mean`; `sd=stdev` (sample n-1); `safety = sd*1.5`; `reorderPoint = avg*leadTime + safety`; `daysOfStock = stock/avg`
- urgency: `None→ok`, `≤leadTime→critical`, `≤2×leadTime→warning`, else `ok`
- confidence: `len≥30→high`, `≥14→medium`, else `low`
- `getReplenishmentList(limit=50)` — candidate `LIMIT 200`; sort critical→soonest stockout

### Anomalies (`anomalies.ts`)
- `Z_THRESHOLD=2.5`; baseline window `days+60`, recent `days`; `z>2.5` flag, `z>3.5` critical
- `detectStocktakeVariance` — latest stocktake only; `≥20%` flag, `≥50%` critical
- **คง dimensional quirk** (recent sum เทียบ per-day baseline) — อย่า "แก้" เงียบ ๆ

> **สำคัญ:** SQL เดิมเป็น SQLite (`julianday`, `strftime`, `date('now')`) → ต้องเขียนใหม่เป็น Postgres (`(g.gr_date - p.po_date)`, `to_char`, `now() - interval`). ค่าคงที่/สูตรต้องตรง แต่ SQL ต้องพอร์ต

### LLM Insights (`llm-insights.ts`)
- 3 ฟังก์ชัน: `getReplenishmentInsight`, `getAnomalyInsight`, `getBulkInsight`
- **Gate:** ไม่มี `ANTHROPIC_API_KEY` → คืน **rule-based fallback** ทันที (ไม่เรียก API) — คงไว้ ให้ระบบรันได้ไม่มี key
- model centralize (เดิม hard-code `claude-sonnet-4-6`); `max_tokens` 300/300/200; ไม่มี system prompt; first content block
- **try/catch → fallback เสมอ** (network/key/model error ไม่ทำ dashboard ล่ม)
- **Thai-only output** + rule-based Thai strings + emoji (เป๊ะตามเดิม — ดู `legacy_inventory/read__analytics.md`)

---

## 4. Endpoints (map เดิม)

| endpoint | service |
|---|---|
| `POST /api/chat` | `AgentService.run` — **เพิ่ม SSE streaming** ไป chat panel; เดิมไม่มี tool access → V2 ต่อ tools จริง (improvement) |
| `GET /api/analytics/replenishment` `/{item_id}` | `forecasting` + `getReplenishmentInsight` |
| `GET /api/analytics/anomalies` | `getAnomalySummary` |
| `POST /api/analytics/insight` | `getReplenishmentInsight`/`getAnomalyInsight` |
| `GET /api/analytics/dashboard-summary` | repl + anomaly + `getBulkInsight` |

---

## 5. การยกระดับ (เพิ่มจากเดิม — ระบุเป็น improvement ตั้งใจ)

- **Prompt caching** บน system prompt ขนาดใหญ่ + tool schemas (ลด cost/latency)
- **SSE streaming** chat (เดิม blocking)
- **per-tenant rate limit** + hard turn/token budget (กัน cost พุ่งตอน concurrent)
- **tools มี RBAC/tenant** (เดิม agent/MCP ไม่มี auth)
- `/api/chat` ดึงข้อมูลจริงได้ (เดิมเป็น passthrough)

---

## 6. MCP server — เก็บไหม?

ระบบเดิมมี `erp_mcp/` (FastMCP) แต่ **agents ไม่ได้ใช้ผ่าน MCP** (มี logic ซ้ำใน `_m_*`). V2 แนะนำ:
- **แหล่งความจริงเดียว** = Service layer (NestJS)
- ถ้าต้องการ MCP (ให้ Claude Desktop/IDE ต่อ ERP) → ทำ thin MCP server ที่ห่อ Service เดิม (ผ่าน HTTP/RPC) — optional, ทำทีหลัง
- เลิก duplicate logic แบบเดิม (`_m_*` + MCP tools + REST = 3 ที่)

> หมายเหตุ: เอกสารเดิม (CLAUDE.md) อ้าง `mcp_server.py`/`agent.py`/`streamlit_chat_page.py` ที่ **ไม่มีจริง** ใน `erp_mcp/` — ของจริงคือ 5 ไฟล์ (`server.py`, `db.py`, 4 tools). อย่ายึดเอกสารเก่า
