/**
 * Step 6 ToE — centralised PDF renderer with out-of-process offload.
 * Chromium is not available in CI, so this exercises the parts that don't need it: the PDF_SERVICE_URL
 * offload path (Chromium runs OUTSIDE the API process), the request contract sent to that service, and the
 * graceful fallback chain (offload error / no service / empty body → null so the caller serves HTML).
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover pdf-render
 */
import 'reflect-metadata';
import { createServer, type Server } from 'node:http';
import { PdfRenderer } from '../../../apps/api/dist/modules/pdf/pdf-renderer.service';

const checks: { name: string; ok: boolean; detail?: string }[] = [];
const ok = (name: string, cond: boolean, detail = '') => checks.push({ name, ok: cond, detail });
const FAKE_PDF = Buffer.from('%PDF-1.4 fake-rendered-bytes');

// A stub "PDF microservice". `mode` flips behaviour to exercise each branch.
let mode: 'ok' | 'error' | 'empty' = 'ok';
let lastBody: any = null;
function startStub(): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        try { lastBody = JSON.parse(raw); } catch { lastBody = null; }
        if (mode === 'error') { res.writeHead(500); res.end('boom'); return; }
        if (mode === 'empty') { res.writeHead(200, { 'content-type': 'application/pdf' }); res.end(); return; }
        res.writeHead(200, { 'content-type': 'application/pdf' }); res.end(FAKE_PDF);
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as any;
      resolve({ server, url: `http://127.0.0.1:${addr.port}/render` });
    });
  });
}

async function main() {
  const { server, url } = await startStub();
  const renderer = new PdfRenderer();
  const HTML = '<html><body>หน้าทดสอบ</body></html>';

  // 1. offload success — bytes come back from the external service (Chromium never touched in-process)
  mode = 'ok';
  process.env.PDF_SERVICE_URL = url;
  const out = await renderer.render(HTML, { format: 'A4', printBackground: true });
  ok('offload returns the external service PDF bytes', !!out && out.equals(FAKE_PDF), `len=${out?.length}`);

  // 2. the request carried the html + options contract
  ok('offload POSTs { html, options } to the service', lastBody?.html === HTML && lastBody?.options?.format === 'A4', JSON.stringify(lastBody)?.slice(0, 80));

  // 3. offload HTTP error → falls through to in-process; no Chromium in CI → null (caller serves HTML)
  mode = 'error';
  const errOut = await renderer.render(HTML);
  ok('offload error falls through to local → null (HTML fallback) in CI', errOut === null, `out=${errOut}`);

  // 4. offload empty body is treated as a failure → null
  mode = 'empty';
  const emptyOut = await renderer.render(HTML);
  ok('offload empty body → null', emptyOut === null, `out=${emptyOut}`);

  // 5. no PDF_SERVICE_URL + no Chromium → null (the pre-existing HTML-fallback behaviour is preserved)
  delete process.env.PDF_SERVICE_URL;
  const localOut = await renderer.render(HTML);
  ok('no service + no Chromium → null (HTML fallback preserved)', localOut === null, `out=${localOut}`);

  await renderer.onModuleDestroy();
  server.close();
  console.log('\n── Step 6 — centralised PDF renderer (offload + fallback) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok).length;
  if (failed) { console.log(`\n❌ ${failed}/${checks.length} pdf-render checks failed`); process.exit(1); }
  console.log(`\n✅ All ${checks.length} pdf-render checks passed`);
}
main().catch((e) => { console.error(e); process.exit(1); });
