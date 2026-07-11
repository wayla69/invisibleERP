import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { RequiresSuite } from '../billing/requires-suite.decorator';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { HcmOrgService, type DepartmentDto, type PositionDto, type AssignmentDto } from './hcm-org.service';

const DepartmentBody = z.object({
  dept_code: z.string().min(1), name: z.string().min(1), parent_dept_code: z.string().optional(),
  cost_center: z.string().optional(), manager_emp_code: z.string().optional(), active: z.boolean().optional(),
});
const PositionBody = z.object({
  position_code: z.string().min(1), title: z.string().min(1), job_grade: z.string().optional(),
  dept_code: z.string().optional(), reports_to_position_code: z.string().optional(),
  budgeted_headcount: z.number().int().nonnegative().optional(), active: z.boolean().optional(),
});
const AssignmentBody = z.object({
  emp_code: z.string().min(1), position_code: z.string().min(1), effective_date: z.string().optional(),
  end_date: z.string().optional(), is_primary: z.boolean().optional(), override_reason: z.string().optional(),
});

// HR-1 (docs/42) — organisation structure & positions. Reads open to hr/hr_admin/exec; writes to hr_admin/exec
// (the guard grants access on ANY listed permission; Admin bypasses). The HR-01 headcount-governance override
// on POST assignments is reserved to `exec` inside the service.
@Controller('api/hcm/org')
@RequiresSuite('hcm')
export class HcmOrgController {
  constructor(private readonly svc: HcmOrgService) {}

  @Get('departments')
  @Permissions('hr', 'hr_admin', 'exec')
  listDepartments(@CurrentUser() u: JwtUser) { return this.svc.listDepartments(u); }

  @Post('departments')
  @Permissions('hr_admin', 'exec')
  createDepartment(@Body(new ZodValidationPipe(DepartmentBody)) b: DepartmentDto, @CurrentUser() u: JwtUser) { return this.svc.createDepartment(b, u); }

  @Get('positions')
  @Permissions('hr', 'hr_admin', 'exec')
  listPositions(@CurrentUser() u: JwtUser) { return this.svc.listPositions(u); }

  @Post('positions')
  @Permissions('hr_admin', 'exec')
  createPosition(@Body(new ZodValidationPipe(PositionBody)) b: PositionDto, @CurrentUser() u: JwtUser) { return this.svc.createPosition(b, u); }

  @Get('assignments')
  @Permissions('hr', 'hr_admin', 'exec')
  listAssignments(@Query('position_code') position: string | undefined, @Query('emp_code') emp: string | undefined, @CurrentUser() u: JwtUser) { return this.svc.listAssignments(position, emp, u); }

  // HR-01 — an assignment beyond the position's budgeted_headcount is blocked (HEADCOUNT_EXCEEDED) unless the
  // caller holds `exec` (override, audit-logged).
  @Post('assignments')
  @Permissions('hr_admin', 'exec')
  createAssignment(@Body(new ZodValidationPipe(AssignmentBody)) b: AssignmentDto, @CurrentUser() u: JwtUser) { return this.svc.createAssignment(b, u); }

  @Get('chart')
  @Permissions('hr', 'hr_admin', 'exec')
  orgChart(@CurrentUser() u: JwtUser) { return this.svc.orgChart(u); }
}
