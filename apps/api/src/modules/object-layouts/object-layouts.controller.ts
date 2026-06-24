import { Controller, Get, Post, Put, Delete, Param, Body, Query } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { ObjectLayoutsService } from './object-layouts.service';

const SectionSchema = z.object({ title: z.string().optional(), columns: z.number().optional(), fields: z.array(z.string()).optional() });
const ConfigSchema = z.object({ sections: z.array(SectionSchema).optional(), hidden: z.array(z.string()).optional() });
const CreateBody = z.object({ object_key: z.string().min(1), name: z.string().min(1), role: z.string().optional(), config: ConfigSchema.optional(), is_default: z.boolean().optional() });
const UpdateBody = z.object({ name: z.string().min(1).optional(), config: ConfigSchema.optional() });
const PreviewBody = z.object({ object_key: z.string().min(1), role: z.string().optional(), config: ConfigSchema.optional() });

// Object layout designer (Phase 12 — A2) — no-code form/layout for custom objects. Presentation only; never
// posts to the ledger. Gated to admin / master-data / exec.
@Controller('api/object-layouts')
export class ObjectLayoutsController {
  constructor(private readonly svc: ObjectLayoutsService) {}

  @Get('resolve') @Permissions('masterdata', 'users', 'exec')
  resolve(@Query('object_key') key: string, @Query('role') role: string | undefined, @CurrentUser() u: JwtUser) { return this.svc.resolve(key, role || null, u); }

  @Post('preview') @Permissions('masterdata', 'users', 'exec')
  preview(@Body(new ZodValidationPipe(PreviewBody)) b: any, @CurrentUser() u: JwtUser) { return this.svc.preview(b.object_key, b.config ?? {}, b.role || null, u); }

  @Get() @Permissions('masterdata', 'users', 'exec')
  list(@Query('object_key') key: string, @CurrentUser() u: JwtUser) { return this.svc.list(key, u); }

  @Post() @Permissions('masterdata', 'users', 'exec')
  create(@Body(new ZodValidationPipe(CreateBody)) b: any, @CurrentUser() u: JwtUser) { return this.svc.create(b, u); }

  @Put(':id') @Permissions('masterdata', 'users', 'exec')
  update(@Param('id') id: string, @Body(new ZodValidationPipe(UpdateBody)) b: any, @CurrentUser() u: JwtUser) { return this.svc.update(+id, b, u); }

  @Post(':id/default') @Permissions('masterdata', 'users', 'exec')
  setDefault(@Param('id') id: string, @CurrentUser() u: JwtUser) { return this.svc.setDefault(+id, u); }

  @Delete(':id') @Permissions('masterdata', 'users', 'exec')
  remove(@Param('id') id: string, @CurrentUser() u: JwtUser) { return this.svc.remove(+id, u); }
}
