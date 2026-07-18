import { afterEach, describe, expect, it } from 'vitest';

import { DocAiService } from '../src/modules/doc-ai/doc-ai.service';
import { setLlmClientForTests, type LlmClient } from '../src/common/llm-client';

// DocAiService routing + fallback ladder, driven end-to-end through a scripted LLM client (the
// tools/cutover/src/ai-eval.ts seam). Constructing the service directly with no db is safe:
// aiTenantOptedOut(undefined, …) is false. NODE_ENV=test → aiDpaBlocked() is false.

const USER = { username: 'ap', role: 'Creditors', tenantId: 1 } as any;

function scripted(text: string): LlmClient & { calls: any[] } {
  const calls: any[] = [];
  return {
    calls,
    async create(params: any) {
      calls.push(params);
      return { content: [{ type: 'text', text }] };
    },
    stream() { throw new Error('not used'); },
  };
}

/** A minimal one-page PDF whose single content stream shows `text` via Tj (uncompressed). */
function miniPdf(text: string): string {
  const esc = text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  const stream = `BT /F1 12 Tf 72 720 Td (${esc}) Tj ET`;
  const pdf = `%PDF-1.4
1 0 obj << /Length ${stream.length} >>
stream
${stream}
endstream
endobj
trailer << >>
%%EOF`;
  return Buffer.from(pdf, 'latin1').toString('base64');
}

afterEach(() => {
  setLlmClientForTests(null);
  delete process.env.ANTHROPIC_API_KEY;
});

describe('DocAiService document routing + normalization', () => {
  it('vision response with fenced JSON + lines + USD → normalized ai fields', async () => {
    process.env.ANTHROPIC_API_KEY = 'fake-key-for-tests';
    const client = scripted('```json\n' + JSON.stringify({
      vendor_name: 'ACME Inc', vendor_tax_id: '0105543001231', invoice_no: 'INV-77',
      invoice_date: '2569-07-18', amount: '1,500.00', currency: 'usd', po_no: null,
      lines: [{ description: 'Widget', qty: 3, unit_price: 500, amount: 1500 }],
    }) + '\n```');
    setLlmClientForTests(client);

    const svc = new DocAiService(undefined);
    const r = await svc.extractInvoiceDocument({ media_type: 'image/png', data: 'aGVsbG8=' }, USER);

    expect(r.source).toBe('ai');
    expect(r.fields.invoice_date).toBe('2026-07-18'); // BE → CE
    expect(r.fields.currency).toBe('USD');
    expect(r.fields.amount).toBe(1500);
    expect(r.fields.lines).toEqual([{ description: 'Widget', qty: 3, unit_price: 500, amount: 1500 }]);
    // the image went to vision as an image content block
    expect(client.calls[0].messages[0].content[0].type).toBe('image');
  });

  it('a PDF whose text layer is mojibake routes to VISION (document block), not the text path', async () => {
    process.env.ANTHROPIC_API_KEY = 'fake-key-for-tests';
    const client = scripted(JSON.stringify({ invoice_no: 'INV-9' }));
    setLlmClientForTests(client);

    // >20 chars of symbol soup — the old length>=20 gate would have taken the text path.
    const garbled = miniPdf('(!) <#> "$%" &\'()* +,-. /:;<=>? @[]^_` {|}~ (!) <#>');
    const svc = new DocAiService(undefined);
    const r = await svc.extractInvoiceDocument({ media_type: 'application/pdf', data: garbled }, USER);

    expect(client.calls).toHaveLength(1);
    expect(client.calls[0].messages[0].content[0].type).toBe('document'); // routed to vision
    expect(r.source).toBe('ai');
    expect(r.fields.invoice_no).toBe('INV-9');
  });

  it('a PDF with a CLEAN text layer stays on the text path (no document block sent)', async () => {
    process.env.ANTHROPIC_API_KEY = 'fake-key-for-tests';
    const client = scripted(JSON.stringify({ invoice_no: 'INV-10', amount: 1500 }));
    setLlmClientForTests(client);

    const clean = miniPdf('ACME Invoice INV-10 Grand Total 1,500.00');
    const svc = new DocAiService(undefined);
    const r = await svc.extractInvoiceDocument({ media_type: 'application/pdf', data: clean }, USER);

    expect(r.source).toBe('ai');
    expect(typeof client.calls[0].messages[0].content).toBe('string'); // text path prompt, not a block array
    expect(r.text).toContain('INV-10');
  });

  it('non-JSON model output → honest empty on the document path, rules-fallback on the text path', async () => {
    process.env.ANTHROPIC_API_KEY = 'fake-key-for-tests';
    setLlmClientForTests(scripted('Sorry, I cannot read this.'));

    const svc = new DocAiService(undefined);
    const doc = await svc.extractInvoiceDocument({ media_type: 'image/png', data: 'aGVsbG8=' }, USER);
    expect(doc.source).toBe('none');
    expect(doc.fields.invoice_no).toBeNull();
    expect(doc.fields.lines).toEqual([]);

    const txt = await svc.extractInvoice('ACME Invoice INV-55 Total USD 1,500.00', USER);
    expect(txt.source).toBe('rules-fallback');
    expect(txt.fields.invoice_no).toBe('INV-55');
    expect(txt.fields.currency).toBe('USD'); // rules currency detection
    expect(txt.fields.lines).toEqual([]); // rules never invent lines
  });

  it('keyless image upload → source none (honest empty, human review)', async () => {
    const svc = new DocAiService(undefined);
    const r = await svc.extractInvoiceDocument({ media_type: 'image/jpeg', data: 'aGVsbG8=' }, USER);
    expect(r.source).toBe('none');
    expect(r.fields).toMatchObject({ vendor_name: null, amount: null, currency: 'THB', lines: [] });
  });
});
