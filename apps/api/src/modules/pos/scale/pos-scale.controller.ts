import { Controller, Get, Post, Param, Body, Sse } from '@nestjs/common';
import { map, filter } from 'rxjs/operators';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../../common/decorators';
import { ZodValidationPipe } from '../../../common/zod-validation.pipe';
import { LockingService } from './locking.service';
import { RealtimeService, drawerKickEscPos } from './realtime.service';

const StatusBody = z.object({
  status: z.enum(['available', 'reserved', 'occupied', 'bill_requested', 'paying', 'cleaning', 'out_of_service']),
  rev: z.number().int(),
});

@Controller('api/pos/scale')
@Permissions('pos', 'order_mgt')
export class PosScaleController {
  constructor(private readonly svc: LockingService, private readonly realtime: RealtimeService) {}

  // Optimistic-locked table status write (rev must match → else 409).
  @Post('table/:id/status') setStatus(@Param('id') id: string, @Body(new ZodValidationPipe(StatusBody)) b: z.infer<typeof StatusBody>) { return this.svc.setTableStatus(+id, b.status, b.rev); }

  // Auto-86 sweep + read availability.
  @Post('availability/recompute') recompute() { return this.svc.recomputeAvailability(); }
  @Get('availability') availability() { return this.svc.availability(); }

  // Realtime table/KDS state: SSE stream for terminals + a buffered recent-events read (testable).
  @Sse('events/stream') stream(@CurrentUser() u: JwtUser) {
    return this.realtime.stream().pipe(filter((e) => e.tenant_id == null || e.tenant_id === u.tenantId), map((data) => ({ data })));
  }
  @Get('events/recent') recent(@CurrentUser() u: JwtUser) { return { events: this.realtime.recent(u.tenantId ?? null), }; }

  // Receipt peripherals: cash-drawer kick + a print job (ESC/POS receipt comes from the receipt endpoint).
  @Post('drawer-kick') drawerKick() { return { command: 'drawer_pulse', escpos_base64: drawerKickEscPos().toString('base64') }; }
  @Post('print-job/:saleNo') printJob(@Param('saleNo') saleNo: string) {
    return { queued: true, sale_no: saleNo, receipt_endpoint: `/api/pos/sales/${saleNo}/receipt?format=escpos`, drawer: { command: 'drawer_pulse', escpos_base64: drawerKickEscPos().toString('base64') } };
  }
}
