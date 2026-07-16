import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { ReservationsService, type ReserveDto } from './reservations.service';

const ReserveBody = z.object({
  project_code: z.string().min(1),
  item_id: z.string().min(1),
  location_id: z.string().optional(),
  qty: z.number().positive(),
  boq_line_id: z.number().int().positive().optional(),
});

// Stock reservation → issue-to-project (M3, docs/32, INV-13). Staff request on-hand stock to be allocated to a
// project (reserve), then issue it (moving inventory value into project WIP). wh_custody/warehouse handle
// custody; procurement/planner may reserve on behalf of a project.
@Controller('api/reservations')
export class ReservationsController {
  constructor(private readonly svc: ReservationsService) {}

  @Post()
  @Permissions('wh_custody', 'warehouse', 'procurement', 'planner')
  reserve(@Body(new ZodValidationPipe(ReserveBody)) b: ReserveDto, @CurrentUser() u: JwtUser) {
    return this.svc.reserve(b, u);
  }

  // A2 (docs/50 Wave 1): release every hold older than max_age_days (default 30) — manual trigger for the
  // scheduled `reservation_stale_release` action job. Planner/warehouse duty (same set that can release).
  @Post('expire-stale')
  @Permissions('wh_custody', 'warehouse', 'procurement', 'planner')
  expireStale(@Query('max_age_days') maxAgeDays: string | undefined, @CurrentUser() u: JwtUser) {
    return this.svc.expireStale(u, maxAgeDays != null ? Number(maxAgeDays) : 30);
  }

  // Available-to-issue for an item+location = on_hand − Σ(held). Static 'available' segment.
  @Get('available')
  @Permissions('wh_custody', 'warehouse', 'procurement', 'planner', 'exec')
  available(@Query('item_id') itemId: string, @Query('location_id') locationId: string | undefined, @CurrentUser() u: JwtUser) {
    return this.svc.available(u, itemId, locationId ?? 'WH-MAIN');
  }

  @Get('project/:code')
  @Permissions('wh_custody', 'warehouse', 'procurement', 'planner', 'exec')
  listForProject(@Param('code') code: string) {
    return this.svc.listForProject(code);
  }

  // Issue a held reservation to the project (relieve inventory → project WIP).
  @Post(':id/issue')
  @Permissions('wh_custody', 'warehouse')
  issue(@Param('id') id: string, @CurrentUser() u: JwtUser) {
    return this.svc.issueToProject(Number(id), u);
  }

  @Post(':id/release')
  @Permissions('wh_custody', 'warehouse', 'procurement', 'planner')
  release(@Param('id') id: string, @CurrentUser() u: JwtUser) {
    return this.svc.release(Number(id), u);
  }
}
