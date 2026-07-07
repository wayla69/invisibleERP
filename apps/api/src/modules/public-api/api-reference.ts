// Wave 2 · 2.12 — self-contained HTML API reference for the public REST API (/api/v1).
// Renders the curated OpenAPI 3.1 document (buildOpenApi) into a single, dependency-free HTML page: no
// external JS/CSS/CDN (CSP-safe under helmet, works offline), no @fastify/static / Swagger-UI dependency.
// Served @Public at GET /api/v1/docs alongside the machine-readable GET /api/v1/openapi.json.

import { buildOpenApi } from './openapi';

const esc = (s: unknown): string =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

const METHOD_ORDER = ['get', 'post', 'put', 'patch', 'delete'];

export function renderApiReferenceHtml(): string {
  const doc: any = buildOpenApi();
  const info = doc.info ?? {};
  const servers: any[] = Array.isArray(doc.servers) ? doc.servers : [];
  const paths: Record<string, any> = doc.paths ?? {};
  const schemas: Record<string, any> = doc.components?.schemas ?? {};

  const endpoints: string[] = [];
  for (const [path, ops] of Object.entries(paths)) {
    for (const method of METHOD_ORDER) {
      const op = ops?.[method];
      if (!op) continue;
      const params: any[] = Array.isArray(op.parameters) ? op.parameters : [];
      const paramRows = params.map((p) =>
        `<tr><td><code>${esc(p.name)}</code></td><td>${esc(p.in)}</td><td>${esc(p.schema?.type ?? '')}</td><td>${p.required ? 'required' : ''}</td></tr>`).join('');
      const scopes: string[] = op.security?.flatMap((s: any) => Object.values(s).flat()) ?? [];
      endpoints.push(`
        <div class="ep">
          <div class="ep-h"><span class="m m-${esc(method)}">${esc(method.toUpperCase())}</span><code class="path">${esc(path)}</code></div>
          ${op.summary ? `<p class="sum">${esc(op.summary)}</p>` : ''}
          ${scopes.length ? `<p class="scopes">scopes: ${scopes.map((s) => `<code>${esc(s)}</code>`).join(' ')}</p>` : ''}
          ${paramRows ? `<table class="params"><thead><tr><th>param</th><th>in</th><th>type</th><th></th></tr></thead><tbody>${paramRows}</tbody></table>` : ''}
        </div>`);
    }
  }

  const schemaList = Object.keys(schemas).map((name) => {
    const props = schemas[name]?.properties ?? {};
    const rows = Object.keys(props).map((k) => `<tr><td><code>${esc(k)}</code></td><td>${esc(props[k]?.type ?? '')}</td></tr>`).join('');
    return `<div class="ep"><div class="ep-h"><code class="path">${esc(name)}</code></div>${rows ? `<table class="params"><tbody>${rows}</tbody></table>` : ''}</div>`;
  }).join('');

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(info.title ?? 'Public API')} — Reference</title>
<style>
  :root{color-scheme:light dark}
  body{font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;max-width:920px;margin:0 auto;padding:32px 20px 80px;color:#1a1d24;background:#fff}
  @media(prefers-color-scheme:dark){body{color:#e6edf3;background:#0e1116}.ep{background:#161b22;border-color:#242c37}code{background:#1b222c}}
  h1{font-size:24px;margin:0 0 4px}.muted{color:#6b7280;font-size:14px}
  .srv{margin:12px 0}code{font-family:ui-monospace,Menlo,monospace;font-size:12.5px;background:#eef1f5;padding:1px 6px;border-radius:5px}
  h2{font-size:16px;margin:28px 0 10px;border-bottom:1px solid #e4e8ee;padding-bottom:6px}
  .ep{border:1px solid #e4e8ee;border-radius:10px;padding:12px 14px;margin:10px 0}
  .ep-h{display:flex;align-items:center;gap:10px}.path{font-size:13px}
  .m{font-weight:700;font-size:11px;padding:2px 8px;border-radius:6px;color:#fff}
  .m-get{background:#2563eb}.m-post{background:#16a34a}.m-put{background:#b45309}.m-patch{background:#7c3aed}.m-delete{background:#b91c1c}
  .sum{margin:8px 0 4px}.scopes{font-size:12px;color:#6b7280;margin:4px 0}
  table.params{width:100%;border-collapse:collapse;font-size:12.5px;margin-top:8px}
  .params th,.params td{text-align:left;padding:4px 8px;border-bottom:1px solid #e4e8ee}
  .params th{color:#6b7280;font-weight:600}
</style></head><body>
<h1>${esc(info.title ?? 'Public API')}</h1>
<div class="muted">Version ${esc(info.version ?? '')} · machine-readable spec: <code>/api/v1/openapi.json</code></div>
${info.description ? `<p>${esc(info.description)}</p>` : ''}
${servers.length ? `<div class="srv">Base URL: ${servers.map((s) => `<code>${esc(s.url)}</code>`).join(' ')}</div>` : ''}
<h2>Endpoints</h2>
${endpoints.join('') || '<p class="muted">No endpoints.</p>'}
${schemaList ? `<h2>Schemas</h2>${schemaList}` : ''}
</body></html>`;
}
