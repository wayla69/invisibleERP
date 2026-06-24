import { Controller, Get, Post, Put, Delete, Param, Body, Query } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { DocumentTemplatesService } from './document-templates.service';

const CreateBody = z.object({
  doc_type: z.string().min(1),
  name: z.string().min(1),
  config: z.record(z.string(), z.any()).optional(),
  is_default: z.boolean().optional(),
});
const UpdateBody = z.object({
  name: z.string().min(1).optional(),
  config: z.record(z.string(), z.any()).optional(),
});
const PreviewBody = z.object({
  doc_type: z.string().min(1),
  config: z.record(z.string(), z.any()).optional(),
});

// Document template designer (Platform Phase 10 — A3). No-code, presentation-only customization of
// customer-facing documents. Gated to org admins / execs; never posts to the ledger.
@Controller('api/document-templates')
export class DocumentTemplatesController {
  constructor(private readonly svc: DocumentTemplatesService) {}

  @Get('doc-types') @Permissions('users', 'exec')
  docTypes() { return this.svc.docTypes(); }

  @Get('active') @Permissions('users', 'exec')
  async active(@Query('doc_type') docType: string) { return { doc_type: docType, config: await this.svc.resolveActive(docType) }; }

  @Get() @Permissions('users', 'exec')
  list(@Query('doc_type') docType: string | undefined, @CurrentUser() u: JwtUser) { return this.svc.list(docType, u); }

  @Post() @Permissions('users', 'exec')
  create(@Body(new ZodValidationPipe(CreateBody)) b: any, @CurrentUser() u: JwtUser) { return this.svc.create(b, u); }

  @Post('preview') @Permissions('users', 'exec')
  preview(@Body(new ZodValidationPipe(PreviewBody)) b: any, @CurrentUser() u: JwtUser) { return this.svc.preview(b.doc_type, b.config ?? {}, u); }

  @Put(':id') @Permissions('users', 'exec')
  update(@Param('id') id: string, @Body(new ZodValidationPipe(UpdateBody)) b: any, @CurrentUser() u: JwtUser) { return this.svc.update(+id, b, u); }

  @Post(':id/default') @Permissions('users', 'exec')
  setDefault(@Param('id') id: string, @CurrentUser() u: JwtUser) { return this.svc.setDefault(+id, u); }

  @Delete(':id') @Permissions('users', 'exec')
  remove(@Param('id') id: string, @CurrentUser() u: JwtUser) { return this.svc.remove(+id, u); }
}
