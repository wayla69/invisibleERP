import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { ProjectsService, type CreateProjectDto, type CostDto, type BillDto } from './projects.service';

const CreateBody = z.object({
  name: z.string().min(1),
  project_code: z.string().optional(),
  customer_name: z.string().optional(),
  billing_type: z.enum(['TM', 'Fixed']).optional(),
  budget_amount: z.number().nonnegative().optional(),
  contract_amount: z.number().nonnegative().optional(),
  start_date: z.string().optional(),
  end_date: z.string().optional(),
});
const CostBody = z.object({
  entry_type: z.enum(['time', 'expense']).optional(),
  description: z.string().optional(),
  qty: z.number().optional(),
  rate: z.number().optional(),
  amount: z.number().optional(),
  billable: z.boolean().optional(),
  entry_date: z.string().optional(),
});
const BillBody = z.object({ amount: z.number().positive() });

@Controller('api/projects')
@Permissions('exec', 'planner', 'ar')
export class ProjectsController {
  constructor(private readonly svc: ProjectsService) {}

  @Post()
  create(@Body(new ZodValidationPipe(CreateBody)) b: CreateProjectDto, @CurrentUser() u: JwtUser) {
    return this.svc.create(b, u);
  }

  @Get()
  list(@CurrentUser() u: JwtUser) {
    return this.svc.list(u);
  }

  @Get(':code')
  get(@Param('code') code: string) {
    return this.svc.get(code);
  }

  @Post(':code/cost')
  cost(@Param('code') code: string, @Body(new ZodValidationPipe(CostBody)) b: CostDto, @CurrentUser() u: JwtUser) {
    return this.svc.logCost(code, b, u);
  }

  @Post(':code/bill')
  bill(@Param('code') code: string, @Body(new ZodValidationPipe(BillBody)) b: BillDto, @CurrentUser() u: JwtUser) {
    return this.svc.bill(code, b, u);
  }
}
