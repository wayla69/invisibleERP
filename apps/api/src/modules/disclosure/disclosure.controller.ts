import { Controller, Get, Post, Put, Body, Param, HttpCode, ParseIntPipe } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { DisclosureService } from './disclosure.service';

const OpenBody = z.object({
  period: z.string().regex(/^\d{4}-\d{2}$/, 'period must be YYYY-MM'),
  title: z.string().max(200).optional(),
});
type OpenBodyT = z.infer<typeof OpenBody>;

const ItemBody = z.object({
  status: z.enum(['Open', 'Complete', 'NA']).optional(),
  support_doc_ref: z.string().max(200).optional(),
  owner: z.string().max(120).optional(),
  notes: z.string().max(2000).optional(),
});
type ItemBodyT = z.infer<typeof ItemBody>;

// CLS-02 (control GL-26) — Disclosure / close-package checklist (governed close binder).
// open seeds the standard TFRS/SEC items; updateItem completes/NAs an item (+ support-doc evidence);
// review is the maker-checker sign-off gate (all items Complete/NA → else ITEMS_INCOMPLETE; reviewer ≠
// preparer → SOD_SELF_APPROVAL) and issue releases the financials. Posts nothing to the GL.
@Controller('api/close/disclosure')
export class DisclosureController {
  constructor(private readonly svc: DisclosureService) {}

  @Get()
  @Permissions('gl_close', 'gl_post', 'fin_report', 'exec')
  list() {
    return this.svc.list();
  }

  @Get(':id')
  @Permissions('gl_close', 'gl_post', 'fin_report', 'exec')
  get(@Param('id', ParseIntPipe) id: number) {
    return this.svc.get(id);
  }

  @Post()
  @HttpCode(201)
  @Permissions('gl_close')
  open(@Body(new ZodValidationPipe(OpenBody)) b: OpenBodyT, @CurrentUser() u: JwtUser) {
    return this.svc.open({ period: b.period, title: b.title, preparedBy: u.username });
  }

  @Put(':id/items/:itemId')
  @HttpCode(200)
  @Permissions('gl_close')
  updateItem(
    @Param('id', ParseIntPipe) id: number,
    @Param('itemId', ParseIntPipe) itemId: number,
    @Body(new ZodValidationPipe(ItemBody)) b: ItemBodyT,
    @CurrentUser() u: JwtUser,
  ) {
    return this.svc.updateItem({ checklistId: id, itemId, status: b.status, supportDocRef: b.support_doc_ref, owner: b.owner, notes: b.notes, updatedBy: u.username });
  }

  @Post(':id/review')
  @HttpCode(200)
  @Permissions('gl_close')
  review(@Param('id', ParseIntPipe) id: number, @CurrentUser() u: JwtUser) {
    return this.svc.review({ checklistId: id, reviewedBy: u.username });
  }

  @Post(':id/issue')
  @HttpCode(200)
  @Permissions('gl_close')
  issue(@Param('id', ParseIntPipe) id: number, @CurrentUser() u: JwtUser) {
    return this.svc.issue({ checklistId: id, issuedBy: u.username });
  }
}
