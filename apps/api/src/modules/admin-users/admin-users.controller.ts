import { Controller, Get, Post, Patch, Delete, Param, Body, Query, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { AdminUsersService } from './admin-users.service';

const ROLES = [
  'Admin', 'Sales', 'Customer', 'Warehouse', 'Procurement', 'Planner',
  'Cashier', 'PosSupervisor', 'ArClerk', 'ApClerk', 'Buyer', 'WarehouseOperator',
  'InventoryController', 'StockCounter', 'GlAccountant', 'FinancialController',
  'MasterDataAdmin', 'PricingManager', 'CreditManager', 'ReturnsClerk', 'AccessAdmin', 'ExecutiveViewer',
] as const;
const CreateBody = z.object({ username: z.string().min(1), password: z.string().min(6), role: z.enum(ROLES), customer_name: z.string().optional(), permissions: z.array(z.string()).optional(), allow_sod_override: z.boolean().optional(), sod_reason: z.string().optional() });
const UpdateBody = z.object({ role: z.enum(ROLES).optional(), customer_name: z.string().optional(), permissions: z.array(z.string()).optional(), allow_sod_override: z.boolean().optional(), sod_reason: z.string().optional() });
const ResetBody = z.object({ password: z.string().min(6) });
const CertifyBody = z.object({ period: z.string().min(1), notes: z.string().optional() });
const RejectExcBody = z.object({ reason: z.string().max(500).optional() });

@Controller('api/admin/users')
@Permissions('users')
export class AdminUsersController {
  constructor(private readonly svc: AdminUsersService) {}

  @Get() list() { return this.svc.list(); }

  // ── ITGC-AC-08: User Access Review ──
  @Get('access-review') accessReview() { return this.svc.accessReview(); }
  @Get('access-review/certifications') reviewCertifications() { return this.svc.listReviews(); }
  @Get('access-review/export') async exportReview(@Res() reply: FastifyReply) {
    const csv = await this.svc.exportReviewCsv();
    reply.header('Content-Type', 'text/csv; charset=utf-8').header('Content-Disposition', 'attachment; filename="access-review.csv"').send(csv);
  }
  @Post('access-review/certify') certifyReview(@Body(new ZodValidationPipe(CertifyBody)) b: z.infer<typeof CertifyBody>, @CurrentUser() u: JwtUser) { return this.svc.certifyReview(b, u); }

  // ── ITGC-AC-09 (audit G11): two-person SoD-exception maker-checker ──
  // A SoD-conflicting grant is staged (by create/update with allow_sod_override + reason) and listed here;
  // a DIFFERENT admin (≠ requester, ≠ the affected user) approves it to apply, or rejects it.
  @Get('access-exceptions') listExceptions(@Query('status') status?: string) { return this.svc.listExceptions(status); }
  @Post('access-exceptions/:reqNo/approve') approveException(@Param('reqNo') reqNo: string, @CurrentUser() u: JwtUser) { return this.svc.approveException(reqNo, u); }
  @Post('access-exceptions/:reqNo/reject') rejectException(@Param('reqNo') reqNo: string, @Body(new ZodValidationPipe(RejectExcBody)) b: z.infer<typeof RejectExcBody>, @CurrentUser() u: JwtUser) { return this.svc.rejectException(reqNo, u, b.reason); }
  @Post() create(@Body(new ZodValidationPipe(CreateBody)) b: z.infer<typeof CreateBody>, @CurrentUser() actor: JwtUser) { return this.svc.create(b, actor); }
  @Patch(':username') update(@Param('username') u: string, @Body(new ZodValidationPipe(UpdateBody)) b: z.infer<typeof UpdateBody>, @CurrentUser() actor: JwtUser) { return this.svc.update(u, b, actor); }
  @Post(':username/reset-password') reset(@Param('username') u: string, @Body(new ZodValidationPipe(ResetBody)) b: z.infer<typeof ResetBody>) { return this.svc.resetPassword(u, b.password); }
  @Delete(':username') remove(@Param('username') u: string, @CurrentUser() actor: JwtUser) { return this.svc.remove(u, actor); }
}
