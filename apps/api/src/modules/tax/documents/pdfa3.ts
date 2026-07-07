// PDF/A-3-oriented embedded-XML archival (docs/ops/etax-production-spike.md gap #4). Embeds the e-Tax UBL
// 2.1 XML (signed when a cert is configured, else unsigned) as a named attachment inside the human-readable
// invoice PDF — the AFRelationship/PDF-A3 embedding convention pdf-lib itself documents (see its
// FileEmbedder.d.ts) and the one hybrid e-invoicing formats (Factur-X/ZUGFeRD) use for exactly this purpose:
// one file a human opens, that also carries the machine-readable legal document.
//
// Scope honesty (mirrors how gap #1's C14N work flagged residual risk): this declares PDF/A-3B conformance
// via an XMP packet and attaches the XML, which is the part of gap #4 that matters for archival (the human
// document carries the legal XML). It does NOT embed an ICC OutputIntent or run the result through a real
// conformance checker (e.g. veraPDF) — neither is available in this environment, so "PDF/A-3 validated" is
// NOT claimed. If a strict validator later rejects it for the missing OutputIntent, that is a small, bounded
// follow-up (embed one standard sRGB ICC profile), not a redesign.
import { PDFDocument, PDFName, AFRelationship } from 'pdf-lib';

export interface PdfA3Options {
  docNo: string;
  signed: boolean;
  sellerName?: string | null;
}

function escapeXml(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function buildXmpPacket(opts: PdfA3Options, createDate: string): string {
  const title = escapeXml(`e-Tax Invoice ${opts.docNo}`);
  const desc = escapeXml(`ETDA UBL 2.1 e-Tax Invoice, ${opts.signed ? 'XAdES-signed' : 'unsigned'}, embedded as an attachment`);
  return [
    `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>`,
    `<x:xmpmeta xmlns:x="adobe:ns:meta/">`,
    ` <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">`,
    `  <rdf:Description rdf:about=""`,
    `    xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/"`,
    `    xmlns:dc="http://purl.org/dc/elements/1.1/"`,
    `    xmlns:pdf="http://ns.adobe.com/pdf/1.3/"`,
    `    xmlns:xmp="http://ns.adobe.com/xap/1.0/">`,
    `   <pdfaid:part>3</pdfaid:part>`,
    `   <pdfaid:conformance>B</pdfaid:conformance>`,
    `   <dc:title><rdf:Alt><rdf:li xml:lang="x-default">${title}</rdf:li></rdf:Alt></dc:title>`,
    `   <dc:description><rdf:Alt><rdf:li xml:lang="x-default">${desc}</rdf:li></rdf:Alt></dc:description>`,
    `   <pdf:Producer>Invisible ERP</pdf:Producer>`,
    `   <xmp:CreateDate>${createDate}</xmp:CreateDate>`,
    `  </rdf:Description>`,
    ` </rdf:RDF>`,
    `</x:xmpmeta>`,
    `<?xpacket end="w"?>`,
  ].join('\n');
}

// Post-process an already-rendered invoice PDF (bytes from PdfRenderer) to embed the e-Tax XML + XMP.
export async function embedEtaxXmlInPdf(pdfBytes: Buffer, xml: string, opts: PdfA3Options): Promise<Buffer> {
  const doc = await PDFDocument.load(pdfBytes, { updateMetadata: false });
  const now = new Date();

  doc.setTitle(`e-Tax Invoice ${opts.docNo}`);
  doc.setSubject('ETDA e-Tax Invoice & e-Receipt — UBL 2.1 XML embedded for archival');
  doc.setProducer('Invisible ERP');
  doc.setCreator('Invisible ERP e-Tax module');
  doc.setKeywords(['e-Tax', 'UBL 2.1', opts.docNo, ...(opts.sellerName ? [opts.sellerName] : [])]);

  await doc.attach(new TextEncoder().encode(xml), `${opts.docNo}.xml`, {
    mimeType: 'application/xml',
    description: `ETDA e-Tax Invoice UBL 2.1 XML (${opts.signed ? 'XAdES-signed' : 'unsigned'}) for ${opts.docNo}`,
    creationDate: now,
    modificationDate: now,
    afRelationship: AFRelationship.Alternative,
  });

  const xmpBytes = new TextEncoder().encode(buildXmpPacket(opts, now.toISOString()));
  const metadataRef = doc.context.register(
    doc.context.stream(xmpBytes, { Type: 'Metadata', Subtype: 'XML', Length: xmpBytes.length }),
  );
  doc.catalog.set(PDFName.of('Metadata'), metadataRef);

  return Buffer.from(await doc.save());
}
