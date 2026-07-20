/**
 * Invisible ERP — MCP Server
 * Exposes key ERP endpoints as Claude tools via stdio transport.
 *
 * Config (env vars):
 *   ERP_API_URL   — API base URL (default http://localhost:8000)
 *   ERP_API_TOKEN — Bearer token (set after login; or leave empty and use erp_login first)
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const BASE = process.env.ERP_API_URL ?? 'http://localhost:8000';
let token = process.env.ERP_API_TOKEN ?? '';

async function call(method: string, path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  try { return JSON.parse(text); } catch { return text; }
}

const server = new McpServer({ name: 'ierp-api', version: '1.0.0' });

// ── Auth ──────────────────────────────────────────────────────────────────────

server.tool(
  'erp_login',
  'Login to Invisible ERP and store the JWT token for subsequent calls.',
  { username: z.string(), password: z.string() },
  async ({ username, password }) => {
    const res: any = await call('POST', '/api/login', { username, password });
    if (res?.token) { token = res.token; return { content: [{ type: 'text', text: `Logged in as ${username}. Token stored.` }] }; }
    return { content: [{ type: 'text', text: `Login failed: ${JSON.stringify(res)}` }] };
  }
);

// ── Ledger & Finance ──────────────────────────────────────────────────────────

server.tool(
  'erp_trial_balance',
  'Get the trial balance (debit/credit/net per account) for a given period.',
  { period: z.string().optional().describe('YYYY-MM, e.g. 2026-01'), cost_center: z.string().optional() },
  async ({ period, cost_center }) => {
    const qs = new URLSearchParams();
    if (period) qs.set('period', period);
    if (cost_center) qs.set('cost_center', cost_center);
    const data = await call('GET', `/api/ledger/trial-balance?${qs}`);
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  'erp_journal',
  'List recent journal entries.',
  { limit: z.number().int().min(1).max(100).default(20) },
  async ({ limit }) => {
    const data = await call('GET', `/api/ledger/journal?limit=${limit}`);
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  'erp_pl',
  'Get P&L (Profit & Loss) report for a period.',
  { period: z.string().describe('YYYY-MM'), cost_center: z.string().optional() },
  async ({ period, cost_center }) => {
    const qs = new URLSearchParams({ period });
    if (cost_center) qs.set('cost_center', cost_center);
    const data = await call('GET', `/api/finance/pl?${qs}`);
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  'erp_cash_position',
  'Get current cash position across bank accounts.',
  {},
  async () => {
    const data = await call('GET', '/api/finance/cash-position');
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  }
);

// ── Inventory ─────────────────────────────────────────────────────────────────

server.tool(
  'erp_inventory',
  'List inventory items with current stock levels.',
  { search: z.string().optional(), low_stock: z.boolean().optional() },
  async ({ search, low_stock }) => {
    const qs = new URLSearchParams();
    if (search) qs.set('search', search);
    if (low_stock) qs.set('low_stock', 'true');
    const data = await call('GET', `/api/inventory?${qs}`);
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  }
);

// ── POS / Sales ───────────────────────────────────────────────────────────────

server.tool(
  'erp_sales_today',
  'Get today\'s POS sales summary (cash Z-report).',
  {},
  async () => {
    const data = await call('GET', '/api/finance/kpis');
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  }
);

// ── Planning (EPM) ────────────────────────────────────────────────────────────

server.tool(
  'erp_budget_versions',
  'List budget versions for the current tenant.',
  {},
  async () => {
    const data = await call('GET', '/api/planning/versions');
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  'erp_three_way_variance',
  'Get Budget vs Forecast vs Actual (3-way variance) for a budget version, scenario, and period.',
  {
    version_id: z.number().int(),
    scenario_id: z.number().int(),
    period: z.string().describe('YYYY-MM'),
  },
  async ({ version_id, scenario_id, period }) => {
    const data = await call('GET', `/api/planning/versions/${version_id}/variance?scenario_id=${scenario_id}&period=${period}`);
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  }
);

// ── Consolidation ─────────────────────────────────────────────────────────────

server.tool(
  'erp_consolidation_groups',
  'List consolidation groups.',
  {},
  async () => {
    const data = await call('GET', '/api/consolidation/groups');
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  'erp_run_consolidation',
  'Run group consolidation for a given period.',
  { group_id: z.number().int(), period: z.string().describe('YYYY-MM') },
  async ({ group_id, period }) => {
    const data = await call('POST', `/api/consolidation/groups/${group_id}/run`, { period });
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  }
);

// ── Reconciliation ────────────────────────────────────────────────────────────

server.tool(
  'erp_recon_periods',
  'List account reconciliation periods.',
  {},
  async () => {
    const data = await call('GET', '/api/recon/periods');
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  'erp_profitability_report',
  'Get CO-PA contribution margin report by segment.',
  { period: z.string().describe('YYYY-MM'), segment_type: z.string().optional() },
  async ({ period, segment_type }) => {
    const qs = new URLSearchParams({ period });
    if (segment_type) qs.set('segment_type', segment_type);
    const data = await call('GET', `/api/profitability/report?${qs}`);
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  }
);

// ── Dashboard ─────────────────────────────────────────────────────────────────

server.tool(
  'erp_dashboard',
  'Get the main ERP dashboard KPIs and summary.',
  {},
  async () => {
    const data = await call('GET', '/api/dashboard');
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  }
);

// ── Start ─────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
