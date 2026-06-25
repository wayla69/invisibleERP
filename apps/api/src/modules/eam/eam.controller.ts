import { Controller, Get, Post, Patch, Param, Query, Body } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { qint } from '../../common/query';
import { EamService } from './eam.service';

const WorkOrderBody = z.object({
  asset_no: z.string().min(1),
  type: z.enum(['corrective', 'preventive', 'inspection']).optional(),
  priority: z.enum(['low', 'medium', 'high']).optional(),
  description: z.string().optional(),
  scheduled_date: z.string().optional(),
  vendor_name: z.string().optional(),
  cost_estimate: z.number().nonnegative().optional(),
});
const WoStatusBody = z.object({
  status: z.enum(['in_progress', 'completed', 'cancelled']),
  actual_cost: z.number().nonnegative().optional(),
  downtime_hours: z.number().nonnegative().optional(),
  vendor_name: z.string().optional(),
  meter_reading: z.number().nonnegative().optional(),
  vat_treatment: z.enum(['standard', 'exempt', 'zero']).optional(),
});
const PmScheduleBody = z.object({
  asset_no: z.string().min(1),
  name: z.string().min(1),
  interval_days: z.number().int().positive().optional(),
  meter_interval: z.number().positive().optional(),
  next_due_date: z.string().optional(),
});
const MeterBody = z.object({ meter_value: z.number().nonnegative(), reading_date: z.string().optional(), note: z.string().optional() });
const WoLineBody = z.object({ kind: z.enum(['labor', 'part']), description: z.string().optional(), quantity: z.number().positive().optional(), hours: z.number().nonnegative().optional(), unit_cost: z.number().nonnegative() });

// Enterprise Asset Management — maintenance on the fixed-asset register. Operational (warehouse/maintenance)
// + finance oversight (exec/creditors, since completion can raise an AP payable).
@Controller('api/eam')
@Permissions('exec', 'warehouse', 'creditors')
export class EamController {
  constructor(private readonly svc: EamService) {}

  @Post('work-orders')
  create(@Body(new ZodValidationPipe(WorkOrderBody)) b: z.infer<typeof WorkOrderBody>, @CurrentUser() u: JwtUser) { return this.svc.createWorkOrder(b, u); }

  @Get('work-orders')
  list(@Query('asset_no') assetNo: string | undefined, @Query('status') status: string | undefined, @Query('type') type: string | undefined, @Query('limit') limit: string | undefined, @CurrentUser() u: JwtUser) {
    return this.svc.listWorkOrders(u, { asset_no: assetNo, status, type, limit: qint('limit', limit, 100) });
  }

  @Patch('work-orders/:woNo/status')
  status(@Param('woNo') woNo: string, @Body(new ZodValidationPipe(WoStatusBody)) b: z.infer<typeof WoStatusBody>, @CurrentUser() u: JwtUser) { return this.svc.updateWorkOrderStatus(woNo, b, u); }

  // Labor/parts cost lines on a work order (roll up into its actual cost).
  @Post('work-orders/:woNo/lines')
  addLine(@Param('woNo') woNo: string, @Body(new ZodValidationPipe(WoLineBody)) b: z.infer<typeof WoLineBody>, @CurrentUser() u: JwtUser) { return this.svc.addWoLine(woNo, b, u); }

  @Get('work-orders/:woNo/lines')
  lines(@Param('woNo') woNo: string) { return this.svc.listWoLines(woNo); }

  // Per-asset reliability & cost KPIs (failures, downtime, MTBF, total maintenance cost).
  @Get('assets/:assetNo/reliability')
  reliability(@Param('assetNo') assetNo: string, @CurrentUser() u: JwtUser) { return this.svc.reliability(assetNo, u); }

  @Post('pm-schedules')
  createPm(@Body(new ZodValidationPipe(PmScheduleBody)) b: z.infer<typeof PmScheduleBody>, @CurrentUser() u: JwtUser) { return this.svc.createPmSchedule(b, u); }

  @Get('pm-schedules')
  listPm(@Query('asset_no') assetNo: string | undefined, @CurrentUser() u: JwtUser) { return this.svc.listPmSchedules(u, assetNo); }

  // Cron-callable: raise preventive work orders for every due PM schedule.
  @Post('pm/run')
  runPm(@CurrentUser() u: JwtUser) { return this.svc.runPmDue(u); }

  @Post('assets/:assetNo/meter')
  meter(@Param('assetNo') assetNo: string, @Body(new ZodValidationPipe(MeterBody)) b: z.infer<typeof MeterBody>, @CurrentUser() u: JwtUser) { return this.svc.recordMeter(assetNo, b, u); }

  @Get('assets/:assetNo/meters')
  meters(@Param('assetNo') assetNo: string, @Query('limit') limit: string | undefined, @CurrentUser() u: JwtUser) { return this.svc.listMeters(assetNo, u, qint('limit', limit, 100)); }
}
