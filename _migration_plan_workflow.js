export const meta = {
  name: 'invisible-erp-v2-migration-plan',
  description: 'Reverse-engineer Invisible ERP (Python) and produce a full V2 migration plan (backend, frontend, endpoints, DB, rollout)',
  phases: [
    { title: 'Inventory', detail: 'Parallel readers map every feature, endpoint, tool, table of the legacy system' },
    { title: 'Architecture', detail: 'Judge panel proposes and selects the V2 stack' },
    { title: 'Design', detail: 'Detailed V2 backend, frontend, API, schema, migration & rollout designs' },
    { title: 'Synthesize', detail: 'Merge into one plan + completeness critic' },
  ],
}

// ───────────────────────── Shared context ─────────────────────────
const ROOT = 'C:/Users/ASUS/Invisible ERP'
const MONO = ROOT + '/ERPPOS_Invisible.py'

const MENU_MAP = `Legacy Streamlit monolith feature pages (ERPPOS_Invisible.py, 12,878 lines), by line:
- L1-3665: page_config, i18n (_LANG TH/EN), RBAC menu builder (_build_menu_for_role), sidebar, POS/order entry (nav_pos), Dashboard (nav_dashboard: overview/orders/claims/shortage/raw/PL tabs), Executive (nav_exec)
- L3665-6662: Order Management (nav_order_mgt), Claim Management (nav_claim_mgt), Customer Dashboard (nav_cust_dash), Customer POS (nav_cust_pos), Customer BOM (nav_cust_bom), Customer Variance (nav_cust_variance), Customer Inventory (nav_cust_inventory), Track Order (nav_track)
- L6662-9569: Planner (nav_planner: stock/planner/whatif/dead), Warehouse (nav_warehouse: stocktake/QR), Procurement (nav_procurement: PR/PO/GR/claims/suppliers 7 tabs), Images (nav_images), Master Data (nav_masterdata: upload/view/template/edit), BOM Master (nav_bom_master)
- L9569-12878: AR (nav_ar), Delivery Orders (nav_delivery), Returns (nav_returns), Price List (nav_pricelist), Lots/lot ledger (nav_lots), Locations (nav_locations), Promotions (nav_promos), Mobile settings (nav_mobile), Creditors/AP (nav_creditors), Users/RBAC (nav_users: add/edit/perm/role/del), Marketing (nav_marketing: 9 tabs campaigns/AB/surveys/abandoned/loyalty), Loyalty (nav_loyalty), Survey (nav_survey), Customer CRM (nav_cust_my_crm), Customer Suppliers (nav_cust_my_suppliers)`

const ENDPOINTS = `Legacy FastAPI (api_server.py, 937 lines) endpoints:
POST /api/login, GET /api/auth/me, GET /, GET /api/config, GET /api/dashboard,
GET /api/pos/summary, GET /api/pos/orders, GET /api/pos/orders/{sale_no}, GET /api/pos/sessions,
GET /api/inventory/stock, GET /api/inventory/stock/{item_id}, GET /api/inventory/suppliers, GET /api/inventory/suppliers/{supplier_id}, GET /api/inventory/purchase-orders, GET /api/inventory/purchase-orders/{po_no},
GET /api/finance/pl, GET /api/finance/ap, GET /api/finance/ar, GET /api/finance/kpi,
POST /api/chat, GET /api/reports/daily-sales, GET /api/reports/stock-summary,
GET /api/customers/{name}, GET /api/dashboard/sales-trend, GET /api/notifications,
GET /api/analytics/replenishment, GET /api/analytics/replenishment/{item_id}, GET /api/analytics/anomalies, POST /api/analytics/insight, GET /api/analytics/dashboard-summary
Auth: HMAC-SHA256 signed token (username|role|customer_name|expiry|sig), 30-day expiry. Multi-tenant: role + customer_name scoping.`

const TABLES = `Legacy SQLite DB (Inventory_Master_DB.sqlite) ~67 tables:
tbl_ab_tests, tbl_ab_variants, tbl_abandoned_carts, tbl_ap_transactions, tbl_ar_invoices, tbl_ar_receipts,
tbl_bom_master, tbl_bom_master_lines, tbl_bom_submission_lines, tbl_bom_submissions, tbl_campaign_reads,
tbl_creditors, tbl_cust_bom, tbl_cust_bom_lines, tbl_cust_my_customers, tbl_cust_my_po_items, tbl_cust_my_pos,
tbl_cust_my_suppliers, tbl_cust_pos_items, tbl_cust_pos_sales, tbl_cust_prod_items, tbl_cust_prod_runs,
tbl_cust_stock_log, tbl_cust_variance, tbl_customer_inventory, tbl_customer_items, tbl_customers,
tbl_delivery_orders, tbl_do_items, tbl_doc_status_log, tbl_goods_receipt, tbl_gr_claims, tbl_gr_items,
tbl_location_stock, tbl_locations, tbl_lot_ledger, tbl_loyalty_config, tbl_loyalty_points, tbl_loyalty_txn,
tbl_marketing_campaigns, tbl_notifications, tbl_pending_order_items, tbl_pending_orders, tbl_po_deliveries,
tbl_po_items, tbl_pr_items, tbl_price_list, tbl_promotions, tbl_purchase_orders, tbl_purchase_requests,
tbl_raw_inventory, tbl_return_items, tbl_role_permissions, tbl_sales_orders, tbl_sales_returns, tbl_scan_lines,
tbl_scan_sessions, tbl_stock_movements, tbl_stocktake, tbl_supplier_requests, tbl_suppliers, tbl_survey_responses,
tbl_surveys, tbl_users
Known column quirks: tbl_raw_inventory has "Expired Date" (space), mixed PascalCase/space column names, tbl_users.Permissions is a serialized field. Postgres user store added later (lowercase columns) — dual SQLite/PG path exists.`

const READER_RULES = `You are a reverse-engineering agent. Your output is structured data returned to an orchestrator, NOT shown to a human — no greetings, no "I will now". Be EXHAUSTIVE and precise: read the actual code, do not guess. Output GitHub-flavored Markdown. For every feature include: purpose, key business logic / calculations, inputs & outputs, DB tables read/written, and any parity-critical detail (Thai/English i18n, RBAC gating, multi-tenant customer scoping, document numbering schemes, status workflows). Flag anything that would be easy to silently drop in a rewrite.`

// ───────────────────────── Phase 1: Inventory ─────────────────────────
phase('Inventory')

const monoChunks = [
  { label: 'mono:core-pos-dash', range: 'lines 1-3665', focus: 'app/page config, the full i18n dictionary (_LANG TH/EN keys), RBAC menu builder & permission keys, sidebar/navigation, POS & order entry (nav_pos), main Dashboard tabs (nav_dashboard), Executive view (nav_exec). Catalogue every permission key and every menu nav_ key you find.' },
  { label: 'mono:orders-customer-portal', range: 'lines 3665-6662', focus: 'Order Management, Claim Management, and the entire Customer Portal: Customer Dashboard, Customer POS, Customer BOM, Customer Variance, Customer Inventory, Track Order. Capture multi-tenant customer_name scoping and the claim/return workflow states.' },
  { label: 'mono:supply-chain', range: 'lines 6662-9569', focus: 'Planner (stock/planner/what-if/dead stock), Warehouse (stocktake, QR scanning), Procurement (PR→PO→GR→claims→suppliers), Images, Master Data import/edit, BOM Master. Capture document numbering, approval flows, and replenishment math.' },
  { label: 'mono:finance-marketing', range: 'lines 9569-12878', focus: 'AR, Delivery Orders, Returns, Price List, Lots/lot ledger, Locations, Promotions, Mobile settings, Creditors/AP, Users/RBAC admin, Marketing (campaigns/AB tests/surveys/abandoned carts), Loyalty points, Survey, Customer CRM, Customer Suppliers.' },
]

const otherReaders = [
  { label: 'read:fastapi-endpoints', prompt: `Read ${ROOT}/api_server.py IN FULL. Produce a precise REST contract: for every endpoint give method, path, query/path/body params (names + types), the SQL/data it returns, response JSON shape, auth requirement, and multi-tenant scoping. Also document the auth scheme (_make_token/_verify_token, HMAC), CORS, startup, and Pydantic request models. Note the /api/notifications generation logic and /api/dashboard aggregation.` },
  { label: 'read:mcp-tools', prompt: `Read ${ROOT}/erp_mcp/server.py, ${ROOT}/erp_mcp/db.py, and all of ${ROOT}/erp_mcp/tools/*.py (pos_tools, inventory_tools, finance_tools, report_tools). For each MCP tool: name, signature, what it does, tables touched, and return shape. Document the db.py helpers (fetchall/fetchone/execute, DB_PATH resolution, SQLite vs Postgres handling) and the report generation (Excel/PDF, Thai font THSarabunNew).` },
  { label: 'read:agents', prompt: `Read all of ${ROOT}/agents/*.py (base_agent, erp_agent, pos_agent, inventory_agent, finance_agent, report_agent). Document the agent architecture: the Anthropic tool-loop, how tools are registered/dispatched, system prompts, model used, and how erp_agent (737 lines) orchestrates the sub-agents. This is the AI brain that V2 must preserve.` },
  { label: 'read:analytics', prompt: `Read all of ${ROOT}/analytics/*.py (forecasting, anomalies, llm_insights). Document each algorithm precisely (the math/statistics for replenishment forecasting and anomaly detection), inputs, outputs, and how llm_insights calls Anthropic. These power /api/analytics/* endpoints.` },
  { label: 'read:auth-infra', prompt: `Read ${ROOT}/user_store.py, ${ROOT}/config.json, ${ROOT}/start.sh, ${ROOT}/railway.json, ${ROOT}/nixpacks.toml, ${ROOT}/Procfile, ${ROOT}/requirements.txt, and ${ROOT}/Init_Historical_DB.py. Document: the user store (SQLite + Postgres dual path, password hashing, roles/permissions, init/seed), RBAC role→permission model, deployment (dual-service Railway via SERVICE_TYPE, shared Volume DB at /data, env vars JWT_SECRET/DB_PATH/ANTHROPIC_API_KEY), and dependencies. This defines the operational target for V2.` },
]

const dbReader = { label: 'read:db-schema', prompt: `${READER_RULES}\n\nReverse-engineer the COMPLETE data model. Use the table list below as your checklist — every table must appear in your output, grouped by business domain (Sales/POS, Inventory/Stock, Procurement, Finance AR/AP, BOM/Production, Customer-Portal multi-tenant, Marketing/Loyalty, Logistics/Delivery, System/Auth/Notifications). For each table give: its purpose, key columns (infer PK/FK), and relationships to other tables. Read the actual CREATE/usage in ${MONO} and ${ROOT}/erp_mcp and ${ROOT}/Init_Historical_DB.py where helpful. Call out denormalization, naming inconsistencies, and columns that should become enums/foreign keys in a clean Postgres schema.\n\n${TABLES}` }

const readerPromises = [
  ...monoChunks.map(c => () => agent(
    `${READER_RULES}\n\nRead ${MONO} (${c.range}). FOCUS: ${c.focus}\n\nContext for cross-reference:\n${MENU_MAP}`,
    { label: c.label, phase: 'Inventory' }
  )),
  ...otherReaders.map(r => () => agent(`${READER_RULES}\n\n${r.prompt}`, { label: r.label, phase: 'Inventory' })),
  () => agent(dbReader.prompt, { label: dbReader.label, phase: 'Inventory' }),
]

const readerLabels = [...monoChunks.map(c => c.label), ...otherReaders.map(r => r.label), dbReader.label]
const readerResults = await parallel(readerPromises)
const inventory = {}
readerLabels.forEach((lbl, i) => { inventory[lbl] = readerResults[i] || '(reader returned nothing)' })

const SYSTEM_MAP = readerLabels.map(lbl => `\n\n# ===== ${lbl} =====\n${inventory[lbl]}`).join('\n')
log('Inventory complete — ' + readerLabels.filter(l => inventory[l] && inventory[l].length > 50).length + '/' + readerLabels.length + ' readers returned substantive output')

// ───────────────────────── Phase 2: Architecture ─────────────────────────
phase('Architecture')

const GOALS = `V2 goals (from product owner): keep 100% of legacy functionality; adopt a NEW programming language (NOT Python) and a NEW, more production-flexible database; cleaner restructured architecture for real-world operation. The system is a Thai-language ERP/POS with: ~40 feature pages, ~30 REST endpoints, ~67 tables, multi-tenant customer portal, RBAC, AI agents + analytics (Anthropic), Excel/PDF Thai reports. Currently deployed on Railway as dual service (FastAPI + Streamlit) on a shared SQLite volume. Operator is a small team / solo. Must integrate the Anthropic (Claude) SDK well.`

const proposers = [
  { label: 'arch:ts-fullstack', stack: 'TypeScript end-to-end: NestJS (or Fastify) backend + Next.js (App Router) frontend + PostgreSQL + Prisma/Drizzle ORM. One language front-to-back.' },
  { label: 'arch:go-backend', stack: 'Go backend (Fiber/Echo or chi + sqlc) + PostgreSQL, with a React/Next.js frontend. Performance & single-binary deploy focus.' },
  { label: 'arch:ts-pragmatic', stack: 'Pragmatic TypeScript for a small team: Fastify + tRPC (or Hono) backend + Next.js frontend + PostgreSQL + Drizzle, Supabase/Neon-friendly, optimized for dev velocity and Anthropic SDK integration.' },
]

const proposalResults = await parallel(proposers.map(p => () => agent(
  `You are a software architect. Propose a V2 target architecture using this stack family: ${p.stack}\n\n${GOALS}\n\nProduce a focused markdown proposal covering: (1) the concrete stack & why it fits THIS ERP, (2) backend layering (modules/services/repositories), (3) frontend approach, (4) how multi-tenant RBAC, AI agents/analytics, and Thai Excel/PDF reporting are handled, (5) hosting/deploy on Railway or alternatives, (6) honest weaknesses for a small team. Be concrete, not generic. Your output is data for an orchestrator.\n\nLegacy system overview:\n${MENU_MAP}\n\n${ENDPOINTS}`,
  { label: p.label, phase: 'Architecture' }
)))

const JUDGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    chosen_stack: {
      type: 'object', additionalProperties: false,
      properties: {
        language: { type: 'string' }, backend_framework: { type: 'string' },
        frontend_framework: { type: 'string' }, database: { type: 'string' },
        orm: { type: 'string' }, api_style: { type: 'string' },
        key_libraries: { type: 'array', items: { type: 'string' } },
        hosting: { type: 'string' },
      },
      required: ['language', 'backend_framework', 'frontend_framework', 'database', 'orm', 'api_style', 'key_libraries', 'hosting'],
    },
    rationale: { type: 'string' },
    scorecard: { type: 'array', items: {
      type: 'object', additionalProperties: false,
      properties: { option: { type: 'string' }, total: { type: 'number' }, notes: { type: 'string' } },
      required: ['option', 'total', 'notes'],
    } },
    final_architecture_markdown: { type: 'string' },
  },
  required: ['chosen_stack', 'rationale', 'scorecard', 'final_architecture_markdown'],
}

const decision = await agent(
  `You are the deciding architect. Three V2 architecture proposals follow. Score each (0-10) on: 100% feature-parity feasibility, real-world flexibility, small-team dev velocity, Anthropic/Claude SDK integration, Thai i18n + Excel/PDF reporting fit, Railway/cloud hosting fit, and migration risk. Pick ONE winner (you may graft the best ideas from the others), then write a definitive V2 architecture section in markdown. Bias toward what a small team can actually ship and operate, while honoring the "new language + new flexible DB" requirement.\n\n${GOALS}\n\n--- PROPOSAL A (TS full-stack) ---\n${proposalResults[0]}\n\n--- PROPOSAL B (Go backend) ---\n${proposalResults[1]}\n\n--- PROPOSAL C (TS pragmatic) ---\n${proposalResults[2]}`,
  { label: 'arch:judge', phase: 'Architecture', schema: JUDGE_SCHEMA }
)

const ARCH = `CHOSEN STACK (JSON): ${JSON.stringify(decision.chosen_stack)}\n\nARCHITECTURE DECISION:\n${decision.final_architecture_markdown}`
log('Architecture selected: ' + decision.chosen_stack.language + ' / ' + decision.chosen_stack.backend_framework + ' + ' + decision.chosen_stack.frontend_framework + ' / ' + decision.chosen_stack.database)

// ───────────────────────── Phase 3: Detailed design ─────────────────────────
phase('Design')

const designers = [
  { key: 'parity', label: 'design:feature-parity', prompt: `Produce an EXHAUSTIVE feature-parity matrix as a markdown table mapping every legacy capability to its V2 home. Columns: Legacy area (menu/page or endpoint) | What it does | V2 module/route | V2 API | Notes/risks. Cover ALL ~40 monolith pages AND all sub-tabs AND all ~30 REST endpoints AND the MCP tools and analytics. Goal: a checklist proving 100% coverage so nothing is dropped. Group by domain.` },
  { key: 'backend', label: 'design:backend-arch', prompt: `Design the V2 BACKEND in detail for the chosen stack: folder/module structure (per domain: pos, inventory, procurement, finance, bom, customer-portal, marketing, loyalty, auth, ai, reports, notifications), layering (controller/route → service → repository), shared concerns (config, logging, error handling, validation, pagination, multi-tenant scoping middleware, RBAC guard), background jobs, and how the Anthropic agent/tool-loop + analytics are packaged as services. Include a concrete example module skeleton.` },
  { key: 'api', label: 'design:api-spec', prompt: `Design the COMPLETE V2 API surface. For every legacy endpoint give the V2 equivalent (path, method, params, response) AND add the missing write endpoints the monolith performs directly in Streamlit (create PO/PR/GR, stocktake, claims, returns, delivery orders, price list, lots, locations, promos, users/RBAC, marketing campaigns, loyalty, customer POS/BOM). Organize by resource. Specify auth (JWT), error envelope, pagination, filtering, and the AI chat + analytics endpoints. Note REST vs tRPC/RPC choice from the chosen stack. Output grouped markdown tables.` },
  { key: 'schema', label: 'design:db-schema', prompt: `Design the NEW PostgreSQL schema migrating all ~67 legacy tables into a clean, normalized model. Group by domain. For key tables give CREATE-style column lists with proper types (numeric/decimal for money, timestamptz, enums for status/role/move_type), primary keys, foreign keys, indexes, and uniqueness. Normalize the quirks (e.g. "Expired Date" → expiry_date, serialized Permissions → role_permissions join, multi-tenant via tenant/customer_id). Provide the ORM model strategy for the chosen stack and a mapping table: legacy table.column → new table.column.` },
  { key: 'migration', label: 'design:data-migration', prompt: `Design the DATA MIGRATION (ETL) from SQLite (Inventory_Master_DB.sqlite) to the new PostgreSQL schema. Cover: extraction approach, per-table transform rules (column renames, type coercion, splitting serialized fields, deduping, generating surrogate keys, backfilling tenant_id), load order respecting FKs, idempotency/re-runnability, validation/reconciliation (row counts, checksums, spot totals like AR/AP/stock), and a dry-run + cutover procedure. Provide a concrete migration script outline.` },
  { key: 'frontend', label: 'design:frontend-arch', prompt: `Design the V2 FRONTEND for the chosen stack to replace the Streamlit monolith. Cover: route/page structure mirroring the ~40 pages grouped by RBAC, component library & design system, state/data-fetching, auth flow + token handling, multi-tenant customer-portal vs internal-admin separation, i18n (Thai/English, the legacy _LANG dictionary), forms & tables for heavy data entry (POS, procurement, stocktake), charts/dashboards, AI chat UI, and Thai Excel/PDF report download UX. Include the top-level navigation/IA.` },
  { key: 'ai', label: 'design:ai-integration', prompt: `Design how the AI layer ports to V2: the Anthropic Claude tool-loop (erp_agent + sub-agents), exposing ERP operations as Claude tools, the analytics services (forecasting, anomalies, llm_insights), and whether to keep an MCP server. Cover model selection (use current Claude models), streaming chat endpoint, tool dispatch security (RBAC-aware), prompt/system design, and where AI calls live in the new backend. Map legacy /api/chat and /api/analytics/* to V2.` },
  { key: 'rollout', label: 'design:rollout-risk', prompt: `Design the PHASED MIGRATION ROADMAP and risk plan. Provide concrete phases (e.g. Phase 0 scaffolding/CI, Phase 1 DB+migration, Phase 2 core read APIs + auth, Phase 3 write/transactional modules, Phase 4 frontend, Phase 5 AI, Phase 6 parallel-run & cutover) with deliverables and exit criteria per phase. Include: strangler-fig vs big-bang recommendation, running V1 and V2 side-by-side, a parity test strategy, rollback plan, environments/CI-CD, and a risk register (risk | impact | mitigation). Give a rough sequencing/effort estimate.` },
]

const designResults = await parallel(designers.map(d => () => agent(
  `You are a senior engineer producing a section of an authoritative migration plan. Be exhaustive, concrete, and consistent with the chosen architecture. Output GitHub-flavored Markdown only (this is a document section, no preamble).\n\n=== TARGET ARCHITECTURE ===\n${ARCH}\n\n=== TASK ===\n${d.prompt}\n\n=== LEGACY SYSTEM MAP (authoritative, reverse-engineered) ===\n${SYSTEM_MAP}`,
  { label: d.label, phase: 'Design' }
)))
const designs = {}
designers.forEach((d, i) => { designs[d.key] = designResults[i] || '(designer returned nothing)' })

// ───────────────────────── Phase 4: Synthesize + critic ─────────────────────────
phase('Synthesize')

const assembled = `# Architecture decision\n${decision.final_architecture_markdown}\n\n# Feature parity\n${designs.parity}\n\n# Backend\n${designs.backend}\n\n# API\n${designs.api}\n\n# Database\n${designs.schema}\n\n# Data migration\n${designs.migration}\n\n# Frontend\n${designs.frontend}\n\n# AI integration\n${designs.ai}\n\n# Rollout\n${designs.rollout}`

const synthesis = await agent(
  `You are the lead author. Write the EXECUTIVE SUMMARY and connective tissue for the Invisible ERP V2 migration plan: a crisp overview of the recommended target (stack, DB, deployment), the migration philosophy, a one-screen "at a glance" table of the phases, and the top 5 risks with mitigations. Then write a short "How to read this document" guide. Markdown only, ~1.5 pages. Do not repeat the detailed sections verbatim — summarize and tie them together.\n\nChosen stack: ${JSON.stringify(decision.chosen_stack)}\nRationale: ${decision.rationale}\n\nDetailed sections that follow your summary:\n${assembled.slice(0, 18000)}`,
  { label: 'synth:executive', phase: 'Synthesize' }
)

const CRITIC_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    coverage_ok: { type: 'boolean' },
    unmapped_features: { type: 'array', items: { type: 'string' } },
    unmapped_endpoints: { type: 'array', items: { type: 'string' } },
    unmapped_tables: { type: 'array', items: { type: 'string' } },
    gaps: { type: 'array', items: { type: 'string' } },
    recommendations: { type: 'array', items: { type: 'string' } },
  },
  required: ['coverage_ok', 'unmapped_features', 'unmapped_endpoints', 'unmapped_tables', 'gaps', 'recommendations'],
}

const critic = await agent(
  `You are a completeness critic. The legacy system map and the V2 design follow. Find anything in the legacy system that is NOT covered by the V2 plan: legacy menu pages/tabs, REST endpoints, MCP tools, analytics, or DB tables with no V2 home. List unmapped items by category, plus any correctness gaps or contradictions. Be specific and reference legacy names. If coverage is genuinely complete, say so but still list anything thin.\n\n=== LEGACY CHECKLISTS ===\n${MENU_MAP}\n\n${ENDPOINTS}\n\n${TABLES}\n\n=== V2 PLAN (parity + api + schema) ===\n${designs.parity}\n\n${(designs.api || '').slice(0, 9000)}\n\n${(designs.schema || '').slice(0, 9000)}`,
  { label: 'synth:critic', phase: 'Synthesize', schema: CRITIC_SCHEMA }
)

return {
  chosen_stack: decision.chosen_stack,
  rationale: decision.rationale,
  scorecard: decision.scorecard,
  synthesis,
  sections: {
    architecture: decision.final_architecture_markdown,
    parity: designs.parity,
    backend: designs.backend,
    api: designs.api,
    schema: designs.schema,
    migration: designs.migration,
    frontend: designs.frontend,
    ai: designs.ai,
    rollout: designs.rollout,
  },
  inventory,
  critic,
}
