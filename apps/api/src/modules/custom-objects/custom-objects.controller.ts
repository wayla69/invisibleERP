import { Controller, Get, Post, Put, Delete, Param, Body } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { CustomObjectsService } from './custom-objects.service';

const DefineBody = z.object({
  object_key: z.string().optional(),
  label: z.string().min(1),
  label_en: z.string().optional(),
  icon: z.string().optional(),
});
const RecordBody = z.object({ values: z.record(z.string(), z.any()).optional() });

// Custom objects (Phase 11 — A1) — tenant-defined record types with no code. Field values reuse the Phase 1
// custom-fields API (entity = object_key). Admin/master-data surface; never posts to the ledger.
@Controller('api/custom-objects')
export class CustomObjectsController {
  constructor(private readonly svc: CustomObjectsService) {}

  @Get() @Permissions('masterdata', 'users', 'exec')
  list(@CurrentUser() u: JwtUser) { return this.svc.listObjects(u); }

  @Post() @Permissions('masterdata', 'users', 'exec')
  define(@Body(new ZodValidationPipe(DefineBody)) b: any, @CurrentUser() u: JwtUser) { return this.svc.defineObject(b, u); }

  @Get(':key') @Permissions('masterdata', 'users', 'exec')
  get(@Param('key') key: string, @CurrentUser() u: JwtUser) { return this.svc.getObject(key, u); }

  @Delete(':key') @Permissions('masterdata', 'users', 'exec')
  remove(@Param('key') key: string, @CurrentUser() u: JwtUser) { return this.svc.removeObject(key, u); }

  @Get(':key/records') @Permissions('masterdata', 'users', 'exec')
  listRecords(@Param('key') key: string, @CurrentUser() u: JwtUser) { return this.svc.listRecords(key, u); }

  @Post(':key/records') @Permissions('masterdata', 'users', 'exec')
  createRecord(@Param('key') key: string, @Body(new ZodValidationPipe(RecordBody)) b: any, @CurrentUser() u: JwtUser) { return this.svc.createRecord(key, b.values ?? {}, u); }

  @Get(':key/records/:id') @Permissions('masterdata', 'users', 'exec')
  getRecord(@Param('key') key: string, @Param('id') id: string, @CurrentUser() u: JwtUser) { return this.svc.getRecord(key, id, u); }

  @Put(':key/records/:id') @Permissions('masterdata', 'users', 'exec')
  updateRecord(@Param('key') key: string, @Param('id') id: string, @Body(new ZodValidationPipe(RecordBody)) b: any, @CurrentUser() u: JwtUser) { return this.svc.updateRecord(key, id, b.values ?? {}, u); }

  @Delete(':key/records/:id') @Permissions('masterdata', 'users', 'exec')
  removeRecord(@Param('key') key: string, @Param('id') id: string, @CurrentUser() u: JwtUser) { return this.svc.removeRecord(key, id, u); }
}
