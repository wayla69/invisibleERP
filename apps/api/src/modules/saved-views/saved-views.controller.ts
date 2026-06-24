import { Controller, Get, Post, Delete, Body, Param, Query, ParseIntPipe } from '@nestjs/common';
import { z } from 'zod';
import { SavedViewsService } from './saved-views.service';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { CurrentUser, Permissions } from '../../common/decorators';
import type { JwtUser } from '../../common/decorators';

const CreateBody = z.object({ module: z.string().min(1), name: z.string().min(1), config: z.record(z.any()).optional(), shared: z.boolean().optional() });

// Saved views are a cross-module convenience, so the controller accepts any of the common list-screen
// permissions — most roles can save a personal view of the screens they can already see.
@Controller('api/saved-views')
@Permissions('dashboard', 'exec', 'masterdata', 'warehouse', 'pos', 'ar', 'creditors', 'crm', 'planner', 'order_mgt', 'procurement')
export class SavedViewsController {
  constructor(private readonly svc: SavedViewsService) {}

  @Get()
  list(@Query('module') module?: string, @CurrentUser() user?: JwtUser) { return this.svc.list(module, user!); }

  @Post()
  create(@Body(new ZodValidationPipe(CreateBody)) dto: z.infer<typeof CreateBody>, @CurrentUser() user: JwtUser) { return this.svc.create(dto, user); }

  @Delete(':id')
  remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: JwtUser) { return this.svc.remove(id, user); }
}
