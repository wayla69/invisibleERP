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
    },
  };
}
