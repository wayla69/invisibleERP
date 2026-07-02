import { Controller, Get, Post, Put, Delete, Body, Param, Query, ParseIntPipe } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { SavedSegmentsService } from './saved-segments.service';

const Rule = z.object({ field: z.string(), op: z.string(), value: z.any() });
const CreateBody = z.object({ name: z.string().min(1), match_mode: z.enum(['all', 'any']).optional(), rules: z.array(Rule).default([]) });
const UpdateBody = z.object({ name: z.string().optional(), match_mode: z.enum(['all', 'any']).optional(), rules: z.array(Rule).optional() });

// Saved custom segments (Phase D1). marketing/exec — same gate as the RFM analytics segments.
@Controller('api/loyalty/saved-segments')
export class SavedSegmentsController {
  constructor(private readonly svc: SavedSegmentsService) {}

  @Get('catalog') @Permissions('loyalty', 'marketing', 'exec')
  catalog() { return this.svc.catalog(); }

  @Get() @Permissions('loyalty', 'marketing', 'exec')
  list(@CurrentUser() u: JwtUser) { return this.svc.list(u); }

  @Post() @Permissions('marketing', 'exec')
  create(@Body(new ZodValidationPipe(CreateBody)) b: any, @CurrentUser() u: JwtUser) { return this.svc.create(b, u); }

  @Put(':id') @Permissions('marketing', 'exec')
  update(@Param('id', ParseIntPipe) id: number, @Body(new ZodValidationPipe(UpdateBody)) b: any, @CurrentUser() u: JwtUser) { return this.svc.update(id, b, u); }

  @Delete(':id') @Permissions('marketing', 'exec')
  remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() u: JwtUser) { return this.svc.remove(id, u); }

  @Get(':id/members') @Permissions('loyalty', 'marketing', 'exec')
  members(@Param('id', ParseIntPipe) id: number, @Query('limit') limit: string | undefined, @Query('offset') offset: string | undefined, @CurrentUser() u: JwtUser) {
    return this.svc.resolve(id, { limit: limit != null ? Number(limit) : undefined, offset: offset != null ? Number(offset) : undefined }, u);
  }
}
