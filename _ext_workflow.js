export const meta = {
  name: 'ierp-v2-extensions',
  description: 'Build non-core extensions: customer-portal, marketing/loyalty/BOM, reports (ExcelJS+Playwright), SSE chat',
  phases: [{ title: 'Build', detail: '5 agents implement independent modules in parallel (distinct file paths)' }],
}

const ROOT = 'C:/Users/ASUS/Invisible ERP V2'

const SHARED = `You are a senior NestJS engineer extending an existing, working codebase at ${ROOT} (Invisible ERP V2 — TypeScript, NestJS 10 + Fastify, Drizzle ORM + Postgres).

BEFORE writing, READ these reference files to copy the EXACT pattern (do not invent new conventions):
- ${ROOT}/apps/api/src/modules/finance/finance.service.ts and finance.controller.ts (service injects DRIZZLE + DocNumberService + StatusLogService; Zod DTOs in controller; numeric columns are strings -> Number() them; insert as String(num))
- ${ROOT}/apps/api/src/modules/procurement/procurement.service.ts (transactions via db.transaction, doc numbers, status log, multi-table writes)
- ${ROOT}/apps/api/src/modules/pos/pos.service.ts (read+write, tenant join, loyalty)
- ${ROOT}/apps/api/src/database/schema/index.ts (ALL table exports — use exact camelCase names)
- ${ROOT}/apps/api/src/common/decorators.ts (Permissions, CurrentUser, JwtUser), zod-validation.pipe.ts, doc-number.service.ts, status-log.service.ts
- ${ROOT}/apps/api/src/database/queries.ts (exports ymd, monthStart, n)

KEY CONVENTIONS (follow exactly):
- Service: \`constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb, private readonly docNo: DocNumberService, private readonly statusLog: StatusLogService) {}\` (omit docNo/statusLog if not needed). Use \`const db = this.db as any\` then Drizzle query builder.
- Imports: DRIZZLE/DrizzleDb from '../../database/database.module'; tables from '../../database/schema'; helpers from '../../database/queries'; DocNumberService '../../common/doc-number.service'; StatusLogService '../../common/status-log.service'; decorators '../../common/decorators'; ZodValidationPipe '../../common/zod-validation.pipe'.
- Drizzle: \`import { sql, eq, and, ne, gte, lte, desc, asc } from 'drizzle-orm'\`. Filter enum columns by arbitrary string with \`sql\\\`\${table.col}::text = \${val}\\\`\` (avoid enum-cast errors). numeric money columns: precision is string; do \`Number(x)\` to read, \`String(x)\` to write.
- Controller: \`@Controller('api/...')\`, methods with \`@Permissions(...)\`, \`@Body(new ZodValidationPipe(Schema))\`, \`@CurrentUser() user: JwtUser\`. Errors: throw NestJS exceptions with \`{ code, message, messageTh }\`.
- Doc numbers via DocNumberService (nextDaily('PR'|'PO'|'GR'|'RCP'|'AP'|'DO'|'RTN'|'GRC'|'ST'), nextTenantStamped('SALE'|'PRD'|'PND'|'MPO', tenantCode), nextStamped, invoiceFromOrder). Keep legacy display formats.
- Money/Thai: VAT 7% (0.07). Currency THB. Keep Thai strings where the legacy is Thai.

HARD CONSTRAINTS:
- Create ONLY files under the paths assigned to you. DO NOT edit app.module.ts, package.json, the schema, or ANY existing file outside your assigned module folder.
- DO NOT run pnpm/npm/build/tests. Just write correct, idiomatic .ts files following the pattern.
- Each module folder must export a NestJS @Module class (controllers + providers) so the orchestrator can register it.
- End your final message with a MANIFEST: list every file you created, the @Module class name + import path to register in app.module.ts, and any npm deps your code imports.`

phase('Build')

const agents = [
  {
    label: 'ext:portal',
    prompt: `${SHARED}

=== YOUR AREA: Customer Portal (multi-tenant, tenant-scoped) ===
Create files under ${ROOT}/apps/api/src/modules/portal/ ONLY.

Tenant scoping: every query MUST filter by the caller's tenant. Resolve tenantId from \`user.customerName\` -> tenants.code -> tenants.id (write a small private helper \`tenantId(user)\` that throws Forbidden if user.customerName is null). Tables already exist (camelCase exports): tenants, customerInventory, custStockLog, pendingOrders, pendingOrderItems, customerItems, custVariance, custPosSales, custPosItems, loyaltyConfig, loyaltyPoints, loyaltyTxn, marketingCampaigns, campaignReads, orders, orderLines, orderClaims, items, stockSnapshots.

Endpoints (@Permissions use the cust_* perm tokens):
- GET  /api/portal/dashboard  (cust_dash) — KPIs for this tenant from custPosSales/orders; PLUS auto-reorder side-effect: for customerInventory rows where current_stock <= reorder_point AND no open Draft pending line exists, create/get today's Draft pendingOrders (pendingNo via docNo.nextTenantStamped('PND', code), triggerType 'Auto') and insert pendingOrderItems (suggested=final=reorder_qty, triggerReason). Wrap in try/catch (silent like legacy).
- POST /api/portal/pos/sales (cust_pos) — retail sale: saleNo = docNo.nextTenantStamped('SALE', code); compute subtotal, vat = subtotal*0.07, total; insert custPosSales (status 'Completed') + custPosItems; decrement customerInventory.current_stock (MAX(0,...)) + cust_stock_log (logType 'Sale'); loyalty earn if loyaltyConfig.enabled. Transaction.
- GET  /api/portal/pos/sales (cust_pos) — history (this tenant).
- GET/POST/PATCH /api/portal/inventory (cust_inventory) — list/add/update customerInventory (reorder point/qty).
- GET  /api/portal/pending-orders (cust_inventory); PATCH /api/portal/pending-orders/:no/submit -> status 'Submitted'.
- POST /api/portal/variance (cust_variance) — EOD count: insert custVariance (variance, variance_pct, shift), overwrite customerInventory.current_stock = actual, log cust_stock_log (logType 'EOD-Count'). Anomaly thresholds 10%/5% in response.
- GET  /api/portal/track (track) — orders for this tenant with composite display status (has Claimed+Completed -> 'Partial Claim', etc.).
- Mini-ERP (Owner_Customer == tenant): GET/POST/DELETE /api/portal/my/customers (myCustomers), /my/suppliers (mySuppliers), /my/purchase-orders (myPurchaseOrders + myPoItems, poNo via nextTenantStamped('MPO', code)).

Files: portal.module.ts, portal.controller.ts, portal.service.ts (you may split into portal.pos/inventory/myerp services if cleaner). Export PortalModule.`,
  },
  {
    label: 'ext:marketing',
    prompt: `${SHARED}

=== YOUR AREA: Marketing + Loyalty + Promotions + Surveys ===
Create files under ${ROOT}/apps/api/src/modules/marketing/ and ${ROOT}/apps/api/src/modules/loyalty/ ONLY.

Tables: marketingCampaigns, campaignReads, abTests, abVariants, promotions, promotionItems, priceList, surveys, surveyResponses, surveyAnswers, abandonedCarts, loyaltyConfig, loyaltyPoints, loyaltyTxn, custPosSales, tenants.

marketing module endpoints (@Permissions 'marketing' unless noted):
- POST /api/marketing/campaigns ; PATCH /api/marketing/campaigns/:id/toggle ; GET /api/marketing/campaigns
- GET  /api/marketing/segments — RFM-lite per tenant from custPosSales: compute spend/order_count/last_order/days_since; segment rules: VIP (days<=30 & spend>=75th percentile of spends), Loyal (days<=60 & orders>=3), 'At Risk' (days>90), New (orders==1), else Regular. Return per-tenant segment + counts.
- POST /api/marketing/ab-tests (create test + 2 variants A/B) ; GET /api/marketing/ab-tests (with CTR=clicks/impressions, CVR=conversions/impressions)
- POST /api/marketing/abandoned-carts/remind — set notifiedAt on recovered=false rows
- GET  /api/marketing/campaigns/active (Permissions 'cust_dash','track') — active Popup/Ticker (Active=1, date window) for portal
- Promotions: GET/POST /api/promotions (6 types; Item_IDs -> promotionItems junction), PATCH /api/promotions/:id/toggle
- Price list: GET/POST /api/price-list (effective = special>0 ? special : base*(1-disc/100); tenant null = All Customers)
- Surveys: GET/POST /api/surveys ; POST /api/surveys/:id/responses (NPS + Q1-3 -> surveyAnswers EAV)

loyalty module endpoints:
- GET  /api/loyalty/config ; PUT /api/loyalty/config (singleton id=1) — Permissions 'loyalty','marketing'
- GET  /api/loyalty/me (Permissions 'loyalty') — this tenant's balance/lifetime + recent txn
- POST /api/loyalty/redeem (Permissions 'loyalty') — require balance>=min_redeem; redeem_val=points*baht_per_point; decrement balance; insert loyaltyTxn (Redeem, negative points). Return redeem_val.

Files: marketing/marketing.module.ts, marketing.controller.ts, marketing.service.ts ; loyalty/loyalty.module.ts, loyalty.controller.ts, loyalty.service.ts. Export MarketingModule and LoyaltyModule.`,
  },
  {
    label: 'ext:bom',
    prompt: `${SHARED}

=== YOUR AREA: BOM (master library + costing + push + submissions + production) ===
Create files under ${ROOT}/apps/api/src/modules/bom/ ONLY.

Tables: bomMaster, bomMasterLines, bomSubmissions, bomSubmissionLines, custBom, custBomLines, custProdRuns, custProdItems, custVariance, customerInventory, custStockLog, items, tenants.

Costing (parity — exact): per line qtyBuyUom = qtyUseUom / convFactor; lineCost = qtyBuyUom * unitCost (unitCost from items.unitPrice of the raw material). Per BOM: rawCost = Σ lineCost; total = rawCost + labor + overhead + other; costPerUnit = total / max(yieldQty, 0.001); margin% = (sellingPrice - costPerUnit)/max(sellingPrice,0.001)*100.

Endpoints (@Permissions 'bom_master' for HQ, 'cust_bom' for portal):
- GET/POST/PATCH/DELETE /api/bom/master (+ lines) — recompute costing; INSERT OR REPLACE style (upsert by bomCode).
- POST /api/bom/master/push — body {bom_codes:[], tenant_codes:[]}: for each (bom x tenant) delete-then-insert into custBom + custBomLines (tenant-scoped, active=1).
- GET  /api/bom/submissions ; PATCH /api/bom/submissions/:id/approve — copy submission -> bomMaster (+lines), set status 'Approved'.
- Portal side (@Permissions 'cust_bom'): GET/POST /api/portal/bom — tenant BOM (custBom+custBomLines) AND dual-write to bomSubmissions+bomSubmissionLines (status 'Pending') for HQ approval. Resolve tenantId from user.customerName.
- POST /api/portal/bom/:code/production-runs — runNo via docNo.nextTenantStamped('PRD', code); compute required = qtyBuyUom*batchQty per line; insert custProdRuns + custProdItems; decrement customerInventory raw materials (MAX 0) + cust_stock_log (logType 'Production'); add finished good (+= yieldQty*batchQty) + log (logType 'Production-FG'). Transaction.

Files: bom.module.ts, bom.controller.ts, bom.service.ts. Export BomModule.`,
  },
  {
    label: 'ext:reports',
    prompt: `${SHARED}

=== YOUR AREA: Reports — ExcelJS + Playwright Thai PDF + Express TXT ===
Work under ${ROOT}/apps/api/src/modules/reports/ ONLY. There is an EXISTING reports.module.ts with ReportsService (data methods dailySales(date), stockSummary()). READ it first. ADD new files; you MAY edit reports.module.ts to register new providers/controllers (it is within your folder).

Deps available: exceljs, playwright-core, bahttext (Thai baht-in-words). Tables: custPosSales, custPosItems, stockSnapshots, orders, orderLines, tenants, items.

1) reports-excel.service.ts (ReportExcelService) — uses 'exceljs':
   - dailySalesXlsx(date): orders for date (status != 'Voided') -> workbook 'Daily Sales' sheet, header row fill '1E3C72' white bold, columns Sale No/Date/Customer/Subtotal/Discount/Tax/Total/Payment/Status. Return Buffer.
   - monthlyPlXlsx(month, year): per-day revenue aggregation. Return Buffer.
   - stockSummaryXlsx(lowOnly): latest snapshot (max generate_date), optional av_qty<=0. Return Buffer.

2) reports-pdf.service.ts (ReportPdfService) — uses 'playwright-core':
   - renderHtmlToPdf(html): lazy launch chromium (chromium.launch({headless:true})); set content; pdf A4. WRAP in try/catch — if Chromium unavailable, return null (caller falls back to returning the HTML). Embed Sarabun via Google Fonts <link> in the HTML <head> for Thai.
   - Provide HTML template builders: salesConfirmationHtml(order, lines, tenant), taxInvoiceHtml(...), receiptHtml(...), statementHtml(...). Thai labels.

3) reports-export.service.ts (ReportExportService):
   - expressTxt(orderNo): fixed-width Thai "ใบสั่งขาย" TXT for Express accounting import; add 7% VAT; baht-in-words via require('bahttext'); encode result as a utf-8 string (caller adds BOM). Keep the legacy column structure (best effort; document fields).

4) reports.controller.ts — add/extend endpoints (set Content-Type + Content-Disposition for downloads; return the Buffer/string; for PDF, if service returns null, return the HTML with text/html):
   - GET /api/reports/daily-sales/export?date= (xlsx) ; /monthly-pl/export?month=&year= ; /stock-summary/export?low=  (@Permissions 'dashboard','warehouse')
   - POST /api/orders/:orderNo/export  body {format:'pdf'|'express_txt'} (@Permissions 'order_mgt','pos') — pull order header+lines, dispatch to pdf (sales confirmation) or express txt.

Register all new providers in reports.module.ts (controllers: [ReportsController], providers: [ReportsService, ReportExcelService, ReportPdfService, ReportExportService]).`,
  },
  {
    label: 'ext:sse',
    prompt: `${SHARED}

=== YOUR AREA: SSE streaming chat (backend ai module + frontend chat page) ===
Backend: work under ${ROOT}/apps/api/src/modules/ai/ ONLY (extend existing agent.service.ts + ai.module.ts — READ them first; they already inject Pos/Inventory/Finance/Analytics services and have a tool-loop chat()).
- Add AgentService.stream(message, history, user): an async generator OR Observable that runs the SAME tool-loop, but on the FINAL assistant turn uses Anthropic streaming (client.messages.stream({...})) and yields text deltas. If no ANTHROPIC_API_KEY, yield one event with a Thai 'AI unavailable' note then complete (do NOT 503 the stream).
- Add to AiController a NestJS SSE endpoint: \`@Sse('chat/stream')\` returning \`Observable<MessageEvent>\` (import { Sse, MessageEvent } from '@nestjs/common'; use rxjs). Accept message+history via query or a prior POST; simplest: \`@Sse('chat/stream')\` with \`@Query('message')\`. @Permissions('ai_chat','dashboard'). Each delta -> { data: { delta } }; final -> { data: { done: true, reply } }.
- Keep the existing POST /api/chat working unchanged.

Frontend: create ${ROOT}/apps/web/src/app/(internal)/assistant/page.tsx (READ existing pages like ${ROOT}/apps/web/src/app/(internal)/finance/page.tsx for style + ${ROOT}/apps/web/src/lib/api.ts for token). A chat UI: input + message list; on send, open EventSource to \`\${NEXT_PUBLIC_API_URL}/api/chat/stream?message=...\` with the bearer token (EventSource can't set headers — pass token as \`?token=\` query and have the SSE endpoint also accept it, OR use fetch + ReadableStream. Prefer fetch() + reader to stream with the Authorization header). Append deltas live. Quick-prompt buttons in Thai. Use the existing CSS classes (card/btn/input).
- Also add an '🤖 AI Assistant' nav item: DO NOT edit the existing layout.tsx (orchestrator will add the nav). Just build the page.

Files: extend ai/agent.service.ts + ai/ai.module.ts; create web assistant/page.tsx. Note in manifest that the orchestrator should add a nav entry to (internal)/layout.tsx.`,
  },
]

const results = await parallel(agents.map((a) => () => agent(a.prompt, { label: a.label, phase: 'Build' })))

const manifest = {}
agents.forEach((a, i) => { manifest[a.label] = results[i] || '(no output)' })
return manifest
