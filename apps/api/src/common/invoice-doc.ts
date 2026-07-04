import { BadRequestException } from '@nestjs/common';

// Shared invoice-document upload constraints — the single source of truth for the AP-intake upload
// channel (EXP-10), the doc-ai image/PDF extractor, and the Quick Capture lane (docs/34). Keeping the
// MIME allow-list and the size caps here stops the three surfaces from drifting apart.
export const INVOICE_DOC_MIME: readonly string[] = ['image/png', 'image/jpeg', 'image/webp', 'application/pdf'];

// data-URL char caps (chars ≈ bytes × 4/3). The image cap stays under Claude's 5 MB per-image vision
// limit; the PDF cap keeps an inline-in-DB fallback row sane.
const MAX_DATAURL: Record<string, number> = { 'application/pdf': 12_000_000 };
const MAX_DATAURL_DEFAULT = 6_500_000;

export interface ParsedInvoiceDoc {
  /** Lower-cased MIME type, guaranteed to be one of INVOICE_DOC_MIME. */
  mime: string;
  /** Base64 payload (no `data:...;base64,` prefix) — ready for the LLM client / object store. */
  base64: string;
  /** The original data: URL (stored verbatim on the intake for the audit trail). */
  dataUrl: string;
}

// Parse + validate a base64 `data:` URL of an invoice document. Throws BadRequestException with the
// canonical error codes/messages (BAD_DATA_URL / UNSUPPORTED_FILE_TYPE / FILE_TOO_LARGE) so every intake
// surface reports failures identically.
export function parseInvoiceDataUrl(dataUrl: string): ParsedInvoiceDoc {
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(dataUrl ?? '');
  if (!m) throw new BadRequestException({ code: 'BAD_DATA_URL', message: 'data_url must be a base64 data: URL', messageTh: 'รูปแบบไฟล์ไม่ถูกต้อง' });
  const mime = m[1]!.toLowerCase();
  if (!INVOICE_DOC_MIME.includes(mime)) {
    throw new BadRequestException({ code: 'UNSUPPORTED_FILE_TYPE', message: `Unsupported type ${mime} — use PNG/JPEG/WebP or PDF`, messageTh: 'รองรับเฉพาะรูปภาพ (PNG/JPEG/WebP) และ PDF' });
  }
  if ((dataUrl?.length ?? 0) > (MAX_DATAURL[mime] ?? MAX_DATAURL_DEFAULT)) {
    throw new BadRequestException({ code: 'FILE_TOO_LARGE', message: 'File too large', messageTh: 'ไฟล์ใหญ่เกินไป' });
  }
  return { mime, base64: m[2]!, dataUrl };
}
