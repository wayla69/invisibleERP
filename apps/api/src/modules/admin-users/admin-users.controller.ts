import { Controller, Get, Post, Patch, Delete, Param, Body } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { AdminUsersService } from './admin-users.service';

const ROLES = ['Admin', 'Sales', 'Customer', 'Warehouse', 'Procurement', 'Planner'] as const;
const CreateBody = z.object({ username: z.string().min(1), password: z.string().min(6), role: z.enum(ROLES), customer_name: z.string().optional(), permissions: z.array(z.string()).optional() });
const UpdateBody = z.object({ role: z.enum(ROLES).optional(), customer_name: z.string().optional(), permissions: z.array(z.string()).optional() });
const ResetBody = z.object({ password: z.string().min(6) });

@Controller('api/admin/users')
@Permissions('users')
export class AdminUsersController {
  constructor(private readonly svc: AdminUsersService) {}

  @Get() list() { return this.svc.list(); }
  @Post() create(@Body(new ZodValidationPipe(CreateBody)) b: z.infer<typeof CreateBody>) { return this.svc.create(b); }
  @Patch(':username') update(@Param('username') u: string, @Body(new ZodValidationPipe(UpdateBody)) b: z.infer<typeof UpdateBody>) { return this.svc.update(u, b); }
  @Post(':username/reset-password') reset(@Param('username') u: string, @Body(new ZodValidationPipe(ResetBody)) b: z.infer<typeof ResetBody>) { return this.svc.resetPassword(u, b.password); }
  @Delete(':username') remove(@Param('username') u: string, @CurrentUser() actor: JwtUser) { return this.svc.remove(u, actor); }
}
