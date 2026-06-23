import { Controller, Get, Post, Put, Delete, Param, Body, Query } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { CustomFieldsService } from './custom-fields.service';

const DefBody = z.object({
  entity: z.string().min(1),
  field_key: z.string().optional(),
  label: z.string().min(1),
  label_en: z.string().optional(),
  data_type: z.enum(['text', 'number', 'date', 'boolean', 'select']).optional(),
  options: z.array(z.string()).optional(),
  required: z.boolean().optional(),
  default_value: z.string().optional(),
  help_text: z.string().optional(),
  sort: z.number().int().optional(),
  active: z.boolean().optional(),
});
const ValuesBody = z.object({ entity: z.string().min(1), record_id: z.string().min(1), values: z.record(z.string(), z.any()) });
const BulkBody = z.object({ entity: z.string().min(1), record_ids: z.array(z.string()).min(1) });

@Controller('api/custom-fields')
export class CustomFieldsController {
  constructor(private readonly svc: CustomFieldsService) {}

  // definitions — managed by admins / master-data maintainers
  @Get('defs') @Permissions('masterdata', 'users', 'order_mgt', 'exec', 'pos')
  defs(@Query('entity') entity: string | undefined, @Query('all') all: string | undefined, @CurrentUser() u: JwtUser) { return this.svc.listDefs(entity, u, all === 'true'); }
  @Post('defs') @Permissions('masterdata', 'users', 'exec')
  defineField(@Body(new ZodValidationPipe(DefBody)) b: any, @CurrentUser() u: JwtUser) { return this.svc.defineField(b, u); }
  @Delete('defs/:id') @Permissions('masterdata', 'users', 'exec')
  removeField(@Param('id') id: string, @CurrentUser() u: JwtUser) { return this.svc.removeField(+id, u); }

  // values — readable/writable by users who maintain the underlying records
  @Get('values') @Permissions('masterdata', 'users', 'order_mgt', 'exec', 'pos')
  getValues(@Query('entity') entity: string, @Query('record_id') recordId: string, @CurrentUser() u: JwtUser) { return this.svc.getValues(entity, recordId, u); }
  @Put('values') @Permissions('masterdata', 'users', 'order_mgt', 'exec', 'pos')
  setValues(@Body(new ZodValidationPipe(ValuesBody)) b: any, @CurrentUser() u: JwtUser) { return this.svc.setValues(b.entity, b.record_id, b.values, u); }
  @Post('values/bulk') @Permissions('masterdata', 'users', 'order_mgt', 'exec', 'pos')
  bulk(@Body(new ZodValidationPipe(BulkBody)) b: any, @CurrentUser() u: JwtUser) { return this.svc.getValuesBulk(b.entity, b.record_ids, u); }
}
