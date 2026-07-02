import { Controller, Post, Body, Res, Inject } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { asc, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { items } from '../../database/schema';
import { Permissions } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { buildItemQrPayload } from '@ierp/shared';
import { QrService } from '../qr/qr.service';

const LabelsBody = z.object({
  item_ids: z.array(z.string()).optional(),
  limit: z.number().int().positive().max(2000).optional(),
  cols: z.number().int().positive().max(6).optional(),
  rows: z.number().int().positive().max(10).optional(),
});
type LabelsBodyT = z.infer<typeof LabelsBody>;

// Printable item QR labels (the legacy "QR Label Manager" bulk-print sheet).
@Controller('api/inventory')
@Permissions('warehouse', 'dashboard', 'masterdata')
export class InventoryQrController {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly qr: QrService,
  ) {}

  @Post('qr/labels')
  async labels(@Body(new ZodValidationPipe(LabelsBody)) b: LabelsBodyT, @Res() reply: FastifyReply) {
    const db = this.db;
    const rows = b.item_ids?.length
      ? await db.select().from(items).where(inArray(items.itemId, b.item_ids))
      : await db.select().from(items).orderBy(asc(items.itemId)).limit(b.limit ?? 200);
    const labels = rows.map((it: any) => ({
      payload: buildItemQrPayload({ itemId: it.itemId, desc: it.itemDescription, uom: it.uom, price: it.unitPrice, cat: it.category }),
      title: it.itemId,
      subtitle: it.itemDescription,
      lines: [`UOM: ${it.uom ?? '-'}`, it.unitPrice != null ? `฿${Number(it.unitPrice).toLocaleString()}` : '', it.category ? `${it.category}` : ''].filter(Boolean) as string[],
      badge: 'UNIVERSAL QR',
    }));
    const { pdf, html } = await this.qr.labelsPdf(labels, b.cols ?? 2, b.rows ?? 4);
    if (pdf) reply.header('Content-Type', 'application/pdf').header('Content-Disposition', 'attachment; filename="item_qr_labels.pdf"').header('Content-Length', pdf.length).send(pdf);
    else reply.header('Content-Type', 'text/html; charset=utf-8').send(html);
  }
}
