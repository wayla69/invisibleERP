// Curated OpenAPI 3.1 document for the public REST API (v1). Hand-built (rather than reflected) so
// the published contract is stable and decoupled from internal controller churn. Kept in sync with
// public-api.controller.ts by hand — both reference the same paths/scopes.

const PAGED_QUERY = [
  { name: 'limit', in: 'query', schema: { type: 'integer', default: 50, minimum: 1, maximum: 200 } },
  { name: 'offset', in: 'query', schema: { type: 'integer', default: 0, minimum: 0 } },
];

const listResponse = (itemSchema: object) => ({
  '200': {
    description: 'OK',
    content: {
      'application/json': {
        schema: {
          type: 'object',
          properties: {
            data: { type: 'array', items: itemSchema },
            pagination: {
              type: 'object',
              properties: { limit: { type: 'integer' }, offset: { type: 'integer' }, count: { type: 'integer' } },
            },
          },
        },
      },
    },
  },
});

export function buildOpenApi() {
  return {
    openapi: '3.1.0',
    info: {
      title: 'Invisible ERP — Public API',
      version: 'v1',
      description:
        'Stable, scope-limited read API for integrators. Authenticate with an API key as a Bearer token ' +
        '(`Authorization: Bearer ierp_…`). Every response is tenant-scoped to the key. Endpoints are ' +
        'per-key rate-limited (429 `RATE_LIMITED`).',
    },
    servers: [{ url: '/api/v1' }],
    security: [{ apiKey: [] }],
    components: {
      securitySchemes: {
        apiKey: { type: 'http', scheme: 'bearer', bearerFormat: 'ierp_*', description: 'API key issued at /api/platform/api-keys' },
      },
      schemas: {
        Item: {
          type: 'object',
          properties: {
            item_id: { type: 'string' }, description: { type: 'string', nullable: true },
            uom: { type: 'string', nullable: true }, unit_price: { type: 'number', nullable: true },
            category: { type: 'string', nullable: true },
          },
        },
        InventoryLevel: {
          type: 'object',
          properties: {
            item_id: { type: 'string' }, description: { type: 'string', nullable: true }, uom: { type: 'string', nullable: true },
            current_stock: { type: 'number', nullable: true }, reorder_point: { type: 'number', nullable: true },
            reorder_qty: { type: 'number', nullable: true }, last_updated: { type: 'string', format: 'date-time', nullable: true },
          },
        },
        Order: {
          type: 'object',
          properties: {
            order_no: { type: 'string' }, order_date: { type: 'string', format: 'date', nullable: true },
            status: { type: 'string', nullable: true }, currency: { type: 'string', nullable: true },
            created_at: { type: 'string', format: 'date-time', nullable: true },
          },
        },
        Invoice: {
          type: 'object',
          properties: {
            invoice_no: { type: 'string' }, invoice_date: { type: 'string', format: 'date', nullable: true },
            due_date: { type: 'string', format: 'date', nullable: true }, order_no: { type: 'string', nullable: true },
            amount: { type: 'number', nullable: true }, paid_amount: { type: 'number', nullable: true },
            outstanding: { type: 'number', nullable: true }, status: { type: 'string', nullable: true },
            currency: { type: 'string', nullable: true },
          },
        },
        DailySales: {
          type: 'object',
          properties: {
            date: { type: 'string', format: 'date', nullable: true },
            revenue: { type: 'number', nullable: true }, orders: { type: 'integer', nullable: true },
            product: { type: 'string', nullable: true, description: 'present only when group_by=product' },
            units: { type: 'number', nullable: true, description: 'present only when group_by=product' },
          },
        },
        CustomerPurchaseFacts: {
          type: 'object',
          description: "One loyalty member's rolled-up purchase history — Recency (last_order_date), Frequency (order_count), Monetary (total_spend).",
          properties: {
            customer_no: { type: 'string' }, order_count: { type: 'integer' }, total_spend: { type: 'number' },
            avg_order_value: { type: 'number', nullable: true },
            first_order_date: { type: 'string', format: 'date-time', nullable: true },
            last_order_date: { type: 'string', format: 'date-time', nullable: true },
          },
        },
      },
    },
    paths: {
      '/me': {
        get: {
          summary: 'Identify the calling key (tenant + granted scopes)',
          security: [{ apiKey: [] }],
          responses: {
            '200': {
              description: 'OK',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      principal: { type: 'string' }, tenant_id: { type: 'integer', nullable: true },
                      scopes: { type: 'array', items: { type: 'string' } }, version: { type: 'string' },
                    },
                  },
                },
              },
            },
          },
        },
      },
      '/items': {
        get: {
          summary: 'List the product catalog', security: [{ apiKey: ['catalog:read'] }],
          parameters: [
            ...PAGED_QUERY,
            { name: 'q', in: 'query', schema: { type: 'string' }, description: 'Search item id / description' },
            { name: 'category', in: 'query', schema: { type: 'string' } },
          ],
          responses: listResponse({ $ref: '#/components/schemas/Item' }),
        },
      },
      '/inventory': {
        get: {
          summary: 'List current stock levels (tenant-scoped)', security: [{ apiKey: ['inventory:read'] }],
          parameters: PAGED_QUERY, responses: listResponse({ $ref: '#/components/schemas/InventoryLevel' }),
        },
      },
      '/orders': {
        get: {
          summary: 'List sales orders (tenant-scoped)', security: [{ apiKey: ['orders:read'] }],
          parameters: [...PAGED_QUERY, { name: 'status', in: 'query', schema: { type: 'string' } }],
          responses: listResponse({ $ref: '#/components/schemas/Order' }),
        },
      },
      '/invoices': {
        get: {
          summary: 'List AR invoices (tenant-scoped)', security: [{ apiKey: ['invoices:read'] }],
          parameters: [...PAGED_QUERY, { name: 'status', in: 'query', schema: { type: 'string' } }],
          responses: listResponse({ $ref: '#/components/schemas/Invoice' }),
        },
      },
      '/sales/daily': {
        get: {
          summary: 'Daily revenue series (tenant-scoped) — the MMM target variable',
          description: 'Per-business-day revenue aggregated from POS sales (Voided excluded). `group_by=product` breaks the series down by item. Defaults to the last 90 days; window capped at 366 days. No native marketing-channel dimension — channel attribution is the integrator\'s own.',
          security: [{ apiKey: ['analytics:read'] }],
          parameters: [
            { name: 'from', in: 'query', schema: { type: 'string', format: 'date' } },
            { name: 'to', in: 'query', schema: { type: 'string', format: 'date' } },
            { name: 'group_by', in: 'query', schema: { type: 'string', enum: ['day', 'product'], default: 'day' } },
          ],
          responses: {
            '200': {
              description: 'OK',
              content: { 'application/json': { schema: {
                type: 'object',
                properties: {
                  window: { type: 'object', properties: { from: { type: 'string', format: 'date' }, to: { type: 'string', format: 'date' } } },
                  group_by: { type: 'string' },
                  data: { type: 'array', items: { $ref: '#/components/schemas/DailySales' } },
                },
              } } },
            },
          },
        },
      },
      '/customers/transactions': {
        get: {
          summary: 'Per-customer purchase facts (tenant-scoped) — RFM base',
          description: 'One row per loyalty member with their rolled-up purchase history (order_count, total_spend, last_order_date). Paginated. `from`/`to` filter on last_order_date.',
          security: [{ apiKey: ['analytics:read'] }],
          parameters: [
            ...PAGED_QUERY,
            { name: 'from', in: 'query', schema: { type: 'string', format: 'date' } },
            { name: 'to', in: 'query', schema: { type: 'string', format: 'date' } },
          ],
          responses: listResponse({ $ref: '#/components/schemas/CustomerPurchaseFacts' }),
        },
      },
      '/marketing/experiment-outcomes': {
        get: {
          summary: 'Measured campaign lift — closed-loop pull-back (tenant-scoped)',
          description: 'The ERP\'s measured campaign incrementality (treatment vs randomised holdout control): `{ outcomes: [{ experiment_no, segment, incremental_revenue, lift_pct, treatment_count, control_count, window_days, measured_at }] }`. The Marketing Intelligence Platform pulls these realised outcomes so the next MMM fit can use campaign lift as a regressor. Read-only, RLS tenant-scoped.',
          security: [{ apiKey: ['analytics:read'] }],
          parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer' } }],
          responses: { '200': { description: 'measured experiment outcomes' }, '403': { description: 'INSUFFICIENT_SCOPE (needs analytics:read)' } },
        },
      },
      '/analytics/snapshots': {
        post: {
          summary: 'Push computed analytics results into the ERP (MMM / RFM / TOWS)',
          description: 'Append a computed analytics snapshot per kind for the caller\'s tenant (history preserved). The Marketing Intelligence Platform posts its results here; the ERP stores them tenant-scoped and renders /marketing-intel. An `rfm` snapshot MAY include `members: [{ customer_no, segment }]` — the per-customer assignments land on customer_profiles.mi_rfm_segment so campaigns can target them (audience=mi_segment). Body: `{ snapshots: [{ kind: "mmm"|"rfm"|"tows", payload: {…}, model_run_ref?: string, members?: [...] }] }`.',
          security: [{ apiKey: ['analytics:write'] }],
          responses: { '200': { description: 'pushed count + kinds' }, '400': { description: 'INVALID_SNAPSHOT_KIND / TENANT_REQUIRED' }, '403': { description: 'INSUFFICIENT_SCOPE (needs analytics:write)' } },
        },
      },
      '/loyalty/member': {
        get: {
          summary: 'Read a loyalty member (by code / phone / card)', security: [{ apiKey: ['loyalty:read'] }],
          parameters: [{ name: 'code', in: 'query', schema: { type: 'string' } }, { name: 'phone', in: 'query', schema: { type: 'string' } }, { name: 'card', in: 'query', schema: { type: 'string' } }],
          responses: { '200': { description: 'Member (balance, tier, …)' }, '404': { description: 'Not found' } },
        },
      },
      '/loyalty/enroll': {
        post: {
          summary: 'Enrol a loyalty member', security: [{ apiKey: ['loyalty:write'] }],
          responses: { '201': { description: 'The enrolled member' } },
        },
      },
      '/loyalty/earn': {
        post: {
          summary: 'Credit loyalty points for a spend (fires loyalty.earned)', security: [{ apiKey: ['loyalty:write'] }],
          responses: { '200': { description: 'points_earned + new balance' } },
        },
      },
      '/loyalty/redeem': {
        post: {
          summary: 'Redeem loyalty points (fires loyalty.redeemed)', security: [{ apiKey: ['loyalty:write'] }],
          responses: { '200': { description: 'points_redeemed + redeem_value + new balance' } },
        },
      },
    },
  };
}
