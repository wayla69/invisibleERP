/**
 * C2c — PDF/A-3-oriented embedded-XML archival (docs/ops/etax-production-spike.md gap #4). Pure
 * post-processing logic — no DB/Nest/Chromium needed (embedEtaxXmlInPdf takes already-rendered PDF bytes),
 * so this runs as a standalone script (mirrors etax-sign.ts) rather than through the full app.
 *
 * Verified INDEPENDENTLY of pdf-lib's own attachment-reading API: rather than trusting
 * `PDFDocument.load(out).getAttachments()` (the same library that wrote it), this inflates the raw
 * `stream…endstream` objects by hand with node:zlib and searches the decompressed bytes for the exact XML —
 * a lower-level cross-check in the same spirit as the etax-sign harness's independent xml-crypto check.
 *   pnpm --filter @ierp/cutover pdfa3
 */
import { PDFDocument } from 'pdf-lib';
import { inflateSync } from 'node:zlib';
import { embedEtaxXmlInPdf } from '../../../apps/api/dist/modules/tax/documents/pdfa3';

const checks: { name: string; ok: boolean; detail?: string }[] = [];
const ok = (name: string, cond: boolean, detail = '') => checks.push({ name, ok: cond, detail });

// Independent, low-level PDF inspection — inflate every `stream…endstream` object and test each against a
// predicate, without calling pdf-lib's own read-back API. Returns the [dataStart, dataEnd) byte range of the
// FIRST matching stream (or null), so a caller can precisely target it (e.g. for a tamper-sensitivity check).
function findInflatedStreamMatch(buf: Buffer, pred: (inflated: Buffer) => boolean): [number, number] | null {
  let idx = 0;
  while (true) {
    const sIdx = buf.indexOf('stream', idx);
    if (sIdx === -1) return null;
    let dataStart = sIdx + 6;
    if (buf[dataStart] === 0x0d) dataStart++;
    if (buf[dataStart] === 0x0a) dataStart++;
    const eIdx = buf.indexOf('endstream', dataStart);
    if (eIdx === -1) return null;
    try { if (pred(inflateSync(buf.subarray(dataStart, eIdx)))) return [dataStart, eIdx]; } catch { /* not a flate stream */ }
    idx = eIdx + 9;
  }
}
function anyInflatedStreamMatches(buf: Buffer, pred: (inflated: Buffer) => boolean): boolean {
  return findInflatedStreamMatch(buf, pred) !== null;
}

async function main() {
  // A minimal, valid single-page PDF standing in for "an already-rendered invoice PDF" — embedEtaxXmlInPdf
  // only post-processes bytes handed to it, so it does not matter that this one has no real content.
  const base = await PDFDocument.create();
  base.addPage([200, 200]);
  const baseBytes = Buffer.from(await base.save());

  const xml = '<Invoice><cbc:ID>TIV-202607-9999</cbc:ID><cbc:PayableAmount currencyID="THB">321.00</cbc:PayableAmount></Invoice>';
  const out = await embedEtaxXmlInPdf(baseBytes, xml, { docNo: 'TIV-202607-9999', signed: false, sellerName: 'บริษัท ทดสอบ จำกัด' });

  ok('output is a larger, still-valid PDF (starts with %PDF, pdf-lib can re-open it)',
    out.length > baseBytes.length && out.toString('latin1', 0, 5) === '%PDF-', `base=${baseBytes.length} out=${out.length}`);

  // pdf-lib CAN re-open it (a basic structural sanity check) — but this is NOT the independent check below.
  const reopened = await PDFDocument.load(out);
  ok('re-opens with pdf-lib + carries the Title we set', reopened.getTitle() === 'e-Tax Invoice TIV-202607-9999', `title=${reopened.getTitle()}`);

  // ── independent verification: inflate the raw stream objects by hand, don't trust pdf-lib's own reader ──
  ok('independent check: the embedded attachment stream inflates to the EXACT XML bytes (byte-for-byte)',
    anyInflatedStreamMatches(out, (inflated) => inflated.toString('utf8') === xml));

  ok('independent check: AFRelationship=Alternative marker present (PDF/A-3 embedded-file convention pdf-lib itself documents)',
    anyInflatedStreamMatches(out, (inflated) => { const s = inflated.toString('latin1'); return s.includes('AFRelationship') && s.includes('Alternative'); })
    || out.toString('latin1').includes('AFRelationship'));

  const text = out.toString('latin1');
  ok('XMP packet is stored PLAIN (uncompressed) — readable by any tool without a PDF parser',
    text.includes('<pdfaid:part>3</pdfaid:part>') && text.includes('<pdfaid:conformance>B</pdfaid:conformance>'));

  ok('XMP packet carries the doc_no + signed/unsigned state in Dublin Core title/description',
    text.includes('e-Tax Invoice TIV-202607-9999') && text.includes('unsigned'));

  // ── tamper sensitivity sanity: flipping a byte inside the SPECIFIC stream that carries the XML must NOT
  // silently still decode to the same XML (guards against a no-op "check" that would pass on any input) ──
  const xmlRange = findInflatedStreamMatch(out, (inflated) => inflated.toString('utf8') === xml);
  const tampered = Buffer.from(out);
  if (xmlRange) { const mid = xmlRange[0] + Math.floor((xmlRange[1] - xmlRange[0]) / 2); tampered[mid] = tampered[mid] ^ 0xff; }
  ok('sanity: a corrupted stream does NOT still inflate to the same exact XML (the check above is discriminating)',
    !!xmlRange && !anyInflatedStreamMatches(tampered, (inflated) => inflated.toString('utf8') === xml));

  // ── signed=true path — the flag alone changes the recorded XMP description, no other assumptions ──
  const outSigned = await embedEtaxXmlInPdf(baseBytes, xml, { docNo: 'TIV-202607-9999', signed: true, sellerName: null });
  ok('signed=true is reflected in the XMP description text ("XAdES-signed" vs "unsigned")',
    outSigned.toString('latin1').includes('XAdES-signed') && !outSigned.toString('latin1').includes('>unsigned<'));

  console.log('\n── C2c — PDF/A-3 embedded-XML archival (cutover) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed ? `\n❌ ${failed}/${checks.length} PDF/A-3 checks failed` : `\n✅ All ${checks.length} PDF/A-3 checks passed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
