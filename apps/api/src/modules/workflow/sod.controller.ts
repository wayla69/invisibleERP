import { Controller, Get, Post, Patch, Param, Body } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { SodService } from './sod.service';

const RuleBody = z.object({ name: z.string().min(1), kind: z.enum(['PERM_PAIR', 'MAKER_CHECKER']).optional(), doc_type: z.string().optional(), perm_a: z.string().optional(), perm_b: z.string().optional() });
const ActiveBody = z.object({ active: z.boolean() });

@Controller('api/sod')
export class SodController {
  constructor(private readonly svc: SodService) {}

  @Post('rules') @Permissions('masterdata')
  createRule(@Body(new ZodValidationPipe(RuleBody)) b: any, @CurrentUser() u: JwtUser) { return this.svc.createRule(b, u); }
  @Get('rules') @Permissions('masterdata', 'exec')
  listRules(@CurrentUser() u: JwtUser) { return this.svc.listRules(u); }
  @Patch('rules/:id') @Permissions('masterdata')
  setRuleActive(@Param('id') id: string, @Body(new ZodValidationPipe(ActiveBody)) b: { active: boolean }, @CurrentUser() u: JwtUser) { return this.svc.setRuleActive(+id, b.active, u); }
  @Get('violations') @Permissions('exec')
  violations(@CurrentUser() u: JwtUser) { return this.svc.violationReport(u); }
}
