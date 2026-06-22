import { Controller, Get, Post, Param, Body } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { ProjectsService } from './projects.service';

const ProjectBody = z.object({ code: z.string().optional(), name: z.string().min(1), customer_name: z.string().optional(), status: z.string().optional(), billing_type: z.enum(['TM', 'Fixed', 'Milestone']).optional(), start_date: z.string().optional(), end_date: z.string().optional(), cost_budget: z.number().optional(), revenue_budget: z.number().optional(), default_bill_rate: z.number().optional(), manager: z.string().optional() });
const StatusBody = z.object({ status: z.enum(['Planning', 'Active', 'OnHold', 'Closed']) });
const TaskBody = z.object({ project_id: z.number().int(), code: z.string().optional(), name: z.string().min(1), planned_hours: z.number().optional() });
const TsBody = z.object({ project_id: z.number().int(), task_id: z.number().int().optional(), emp_code: z.string().optional(), work_date: z.string().optional(), hours: z.number().positive(), billable: z.boolean().optional(), bill_rate: z.number().optional(), cost_rate: z.number().optional(), notes: z.string().optional() });
const ExpBody = z.object({ project_id: z.number().int(), exp_date: z.string().optional(), description: z.string().optional(), amount: z.number().positive(), billable: z.boolean().optional(), markup_pct: z.number().optional(), account_code: z.string().optional(), vendor: z.string().optional() });
const MsBody = z.object({ project_id: z.number().int(), name: z.string().min(1), amount: z.number().nonnegative(), due_date: z.string().optional() });

@Controller('api/projects')
@Permissions('exec', 'ar', 'creditors', 'planner')
export class ProjectsController {
  constructor(private readonly svc: ProjectsService) {}

  @Get() list() { return this.svc.listProjects(); }
  @Post() create(@Body(new ZodValidationPipe(ProjectBody)) b: z.infer<typeof ProjectBody>, @CurrentUser() u: JwtUser) { return this.svc.createProject(b, u); }
  @Get(':id/summary') summary(@Param('id') id: string) { return this.svc.summary(+id); }
  @Post(':id/status') setStatus(@Param('id') id: string, @Body(new ZodValidationPipe(StatusBody)) b: z.infer<typeof StatusBody>) { return this.svc.setStatus(+id, b.status); }

  @Post('tasks') createTask(@Body(new ZodValidationPipe(TaskBody)) b: z.infer<typeof TaskBody>, @CurrentUser() u: JwtUser) { return this.svc.createTask(b, u); }
  @Post('timesheets') logTs(@Body(new ZodValidationPipe(TsBody)) b: z.infer<typeof TsBody>, @CurrentUser() u: JwtUser) { return this.svc.logTimesheet(b, u); }
  @Get(':id/timesheets') listTs(@Param('id') id: string) { return this.svc.listTimesheets(+id); }
  @Post('expenses') logExp(@Body(new ZodValidationPipe(ExpBody)) b: z.infer<typeof ExpBody>, @CurrentUser() u: JwtUser) { return this.svc.logExpense(b, u); }
  @Post('milestones') createMs(@Body(new ZodValidationPipe(MsBody)) b: z.infer<typeof MsBody>, @CurrentUser() u: JwtUser) { return this.svc.createMilestone(b, u); }

  @Post(':id/bill-tm') billTm(@Param('id') id: string, @CurrentUser() u: JwtUser) { return this.svc.billTimeAndMaterials(+id, u); }
  @Post('milestones/:id/bill') billMs(@Param('id') id: string, @CurrentUser() u: JwtUser) { return this.svc.billMilestone(+id, u); }
}
