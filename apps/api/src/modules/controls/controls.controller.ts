import { Controller, Get, Post, Param, Body, Query } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { ControlsService } from './controls.service';

const ReviewBody = z.object({ status: z.enum(['reviewed', 'dismissed']) });

// Continuous controls monitoring (Phase 19 — B5). Read-only detective controls; never posts to the GL.
@Controller('api/controls')
export class ControlsController {
  constructor(private readonly svc: ControlsService) {}

  @Get('catalog') @Permissions('exec', 'users', 'creditors')
  catalog() { return this.svc.catalog(); }

  @Post('scan') @Permissions('exec', 'users', 'creditors')
  scan(@CurrentUser() u: JwtUser) { return this.svc.scan(u); }

  @Get('findings') @Permissions('exec', 'users', 'creditors')
  findings(@Query('status') status: string | undefined, @CurrentUser() u: JwtUser) { return this.svc.listFindings(u, status || undefined); }

  @Post('findings/:id/review') @Permissions('exec', 'users', 'creditors')
  review(@Param('id') id: string, @Body(new ZodValidationPipe(ReviewBody)) b: any, @CurrentUser() u: JwtUser) { return this.svc.review(+id, b.status, u); }
}
