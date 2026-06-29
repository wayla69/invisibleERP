import { Injectable, Logger } from '@nestjs/common';
import * as QRCode from 'qrcode';
import { PdfRenderer } from '../pdf/pdf-renderer.service';

export interface QrLabel {
  payload: string;
  title: string; // big mono id (ASCII)
  subtitle?: string; // description (may be Thai)
  lines?: string[]; // small info rows
  badge?: string; // e.g. 'UNIVERSAL QR' | 'ASSET TAG'
}

const ESC = (s: string) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// QR codes for printable labels + scan-to-fill. Reuses the Playwright HTML→PDF path
// (same as ReportPdfService); falls back to returning HTML when Chromium is unavailable.
@Injectable()
export class QrService {
  private readonly logger = new Logger(QrService.name);
  constructor(private readonly pdf: PdfRenderer) {}

  async dataUrl(payload: string, width = 220): Promise<string> {
    return QRCode.toDataURL(payload, { margin: 1, width, errorCorrectionLevel: 'M' });
  }

  /** Build the label-sheet HTML (also returned as a fallback when no Chromium). */
  async labelsHtml(labels: QrLabel[], cols = 2, rows = 4): Promise<string> {
    const cells = await Promise.all(
      labels.map(async (l) => ({ ...l, img: await this.dataUrl(l.payload, 200) })),
    );
    const perPage = cols * rows;
    const cellHtml = (c: (typeof cells)[number]) => `
      <div class="cell">
        <div class="info">
          <div class="title">${ESC(c.title)}</div>
          ${c.subtitle ? `<div class="sub">${ESC(c.subtitle)}</div>` : ''}
          ${(c.lines ?? []).map((x) => `<div class="row">${ESC(x)}</div>`).join('')}
          ${c.badge ? `<div class="badge">${ESC(c.badge)}</div>` : ''}
        </div>
        <img class="qr" src="${c.img}" />
      </div>`;
    const pages: string[] = [];
    for (let i = 0; i < cells.length; i += perPage) {
      pages.push(`<div class="sheet">${cells.slice(i, i + perPage).map(cellHtml).join('')}</div>`);
    }
    return `<!doctype html><html><head><meta charset="utf-8"/>
      <style>
        @page { size: A4; margin: 8mm; }
        * { box-sizing: border-box; font-family: 'Sarabun','TH Sarabun New','Noto Sans Thai',Arial,sans-serif; }
        .sheet { display: grid; grid-template-columns: repeat(${cols}, 1fr); gap: 3mm; page-break-after: always; }
        .cell { display: flex; justify-content: space-between; align-items: center; border: 0.4mm solid #999; border-radius: 2mm; padding: 3mm; height: ${Math.floor((281 - (rows - 1) * 3) / rows)}mm; overflow: hidden; }
        .info { flex: 1; min-width: 0; padding-right: 2mm; }
        .title { font-weight: 800; font-size: 13pt; color: #1c385c; }
        .sub { font-size: 9pt; color: #334; margin: 1mm 0; }
        .row { font-size: 8pt; color: #555; }
        .badge { margin-top: 2mm; display: inline-block; background: #0d8064; color: #fff; font-size: 7pt; font-weight: 700; padding: 0.6mm 2mm; border-radius: 3mm; }
        .qr { width: 30mm; height: 30mm; }
      </style></head><body>${pages.join('')}</body></html>`;
  }

  async labelsPdf(labels: QrLabel[], cols = 2, rows = 4): Promise<{ pdf: Buffer | null; html: string }> {
    const html = await this.labelsHtml(labels, cols, rows);
    // Delegate to the shared renderer (offload or pooled Chromium); null → caller serves the HTML labels.
    const pdf = await this.pdf.render(html, { format: 'A4', printBackground: true });
    return { pdf, html };
  }
}
