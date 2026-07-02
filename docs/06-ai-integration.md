# 06 — AI & Analytics Integration

> **Provider seam (docs/24 R4-4):** every service reaches the model through `common/llm-client.ts` — the
> single construction point for the Anthropic SDK (retries/backoff included) and the injection point
> (`setLlmClientForTests`) that lets the CI eval drive the REAL agent loop with a scripted fake model.
> Still single-provider by design; a second provider would adapt into this contract in one file.
>
> **Semantic embeddings (docs/24 R4-1):** `EMBED_PROVIDER=voyage` (+`VOYAGE_API_KEY`, default model
> `voyage-3-lite`) switches KB retrieval from the local hashed bag-of-words to real semantic vectors.
> Each chunk records its **embedding space** (`kb_chunks.embed_provider`, migration 0213); search only
> compares within the query's space (cross-space cosine is noise), `POST /api/ai/kb/reembed` migrates the
> corpus after switching, and any provider failure or un-acknowledged DPA degrades fail-safe to the local
> embedder (throttled `embed_provider_degraded` ops alert). pgvector indexing remains the at-scale upgrade
> once corpus size demands it — the storage contract (L2-normalized number[]) is unchanged.
>
> **Honest labeling (docs/24 R4-5):** the "demand-ml" module and the analytics forecasters are
> **classical statistics** (SMA/SES/Holt/seasonal-naive/Croston + walk-forward WAPE/MASE backtesting;
> z-score anomaly flags) — deliberately explainable for audit, **not machine learning**, and must not be
> marketed as ML. "AI" in this document means the governed LLM copilot (agent/RAG/doc-extraction), which
> is advisory-only and never posts transactions.

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

**PDPA data-minimization (PII redaction)** — ผลลัพธ์ของ tool ถูกส่งให้โมเดลภายนอก (Anthropic) ดังนั้นก่อนส่งจะ **กรอง PII ที่เป็นตัวระบุติดต่อโดยตรง** (อีเมล/เบอร์โทร/เลขประจำตัว 13 หลัก/ที่อยู่/LINE id และฟิลด์ที่ชื่อบ่งชี้) ผ่าน `common/pii-redact.ts` — **คงชื่อกิจการ/ลูกค้าไว้** (ผู้ช่วยต้องใช้เพื่อให้คำตอบมีประโยชน์) และตัวเลขยอดเงินผ่านได้ตามปกติ ปิดได้ด้วย `AI_PII_REDACTION=off` (ค่าเริ่มต้น on) การทำ pseudonymization เต็มรูปแบบ + DPA กับ Anthropic เป็นมาตรการสมบูรณ์ (อยู่ใน workstream กฎหมาย) — `doc-ai` (สกัดข้อมูลใบแจ้งหนี้ที่ผู้ใช้วางเอง) **ไม่** ถูกกรองเพราะเป็นวัตถุประสงค์โดยตรง ใช้ opt-out ต่อ tenant + DPA กำกับแทน

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
| `POST /api/ai/actions` | `AiActionService.propose` — file a PENDING write-op (Phase D1) |
| `GET /api/ai/actions?status=pending` | `AiActionService.list` — approval queue |
| `POST /api/ai/actions/:id/approve` · `/reject` | `AiActionService.approve`/`reject` — execute on approval |

---

## 4a. Agentic write-ops (Phase D1) — propose → approve → execute

The agent is **read-only by default**; the only way it can change data is to **propose** an action that
a human approves. There is no path for the model to mutate ledgers/POs directly.

- **Propose.** Agent write-tools `propose_journal_entry` / `propose_purchase_order` call
  `AiActionService.propose`, which validates the payload (JE must balance) and writes a **PENDING** row to
  `ai_action_requests` (tenant-scoped via RLS, migration `0063`). The system prompt forbids the model from
  claiming it executed — it must say the action awaits approval.
- **Approve (human-in-the-loop + SoD).** `approve()` enforces: the action is still pending; the **approver
  ≠ the proposer** (`SOD_SELF_APPROVAL`); and the approver holds the **permission for that kind**
  (`gl_post` for a JE, `procurement` for a PO) — else `403`. On approval it executes through the normal
  service (`LedgerService.postEntry` / `ProcurementService.createPo`), records `result_ref` (e.g. `JE-…` /
  `PO-…`), and the standard audit interceptor logs the mutation. Failures flip the row to `failed`.
- **Reject** records `decided_by` + reason. Re-deciding a non-pending action → `409`.
- **UI.** `/ai-actions` (perm `approvals`/`ai_chat`) is the approval queue.
- **Verified by** `tools/cutover/src/ai-actions.ts` (propose, balance guard, self-approval block,
  missing-permission block, execute→JE/PO + balanced GL, re-approve guard, reject, RLS isolation).

---

## 4b. RAG over policies/SOPs/contracts (Phase D2) — cite-or-refuse

The assistant answers policy/procedure questions **only from the tenant's own documents**, citing them —
or it declines. No hallucinated policy.

- **Ingest.** `POST /api/ai/kb/documents` (perm `masterdata`/`ai_chat`) chunks a document (paragraph-
  aware, ~80 words) and embeds each chunk, storing `kb_documents` + `kb_chunks` (migration `0064`,
  tenant-scoped via RLS).
- **Embedder.** `EmbedderService` is pluggable (`EMBED_PROVIDER`); the **default is a deterministic,
  dependency-free local embedder** (hashed bag-of-words + bigrams, stopword-filtered, L2-normalized) so
  retrieval is testable offline with no API key. Embeddings are stored as a plain `number[]` (jsonb) and
  cosine is computed in-service — **no pgvector dependency**, so the PGlite harnesses run unchanged.
  *Prod path:* set `EMBED_PROVIDER` to a real model and move `embedding` to a pgvector column + ANN
  index behind the same call sites.
- **Retrieve + cite-or-refuse.** `KnowledgeService.search` ranks the tenant's chunks by cosine;
  `ask()` returns citations only when the top score clears `KB_MIN_SCORE` (default 0.15) — otherwise it
  **refuses** (no citation ⇒ no answer). Agent tool `search_knowledge_base` exposes this to the chat
  loop, and the system prompt instructs the model to answer only from results and cite the source.
- **Endpoints:** `POST /api/ai/kb/documents`, `GET /api/ai/kb/search?q=`, `GET /api/ai/kb/ask?q=`.
- **Verified by** `tools/cutover/src/rag.ts` (ingest→chunks, relevant retrieval + citation, off-topic
  **refusal**, tenant isolation).

> **Scale/perf note:** in-service cosine over all tenant chunks is fine for modest corpora and keeps the
> feature verifiable here; pgvector + ANN is the drop-in upgrade for large knowledge bases.

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
