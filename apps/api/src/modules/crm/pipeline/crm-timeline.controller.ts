import { Controller, Get, Post, Query, Body, HttpCode } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../../common/decorators';
import { ZodValidationPipe } from '../../../common/zod-validation.pipe';
import { CrmTimelineService } from './crm-timeline.service';

const ENTITY = z.enum(['lead', 'opportunity', 'account']);
const FeedPostBody = z.object({ entity_type: ENTITY, entity_no: z.string().min(1), body: z.string().min(1).max(5000) });

// CRM-8 unified activity timeline + collaboration feed (control CRM-14). Reads gate crm/exec/ar (same as the
// pipeline). The unified timeline is the ONE canonical, chronological record of every touch on a customer
// record; the feed is an append-only internal note stream with @mention routing.
@Controller('api/crm')
@Permissions('crm', 'exec', 'ar')
export class CrmTimelineController {
  constructor(private readonly svc: CrmTimelineService) {}

  // GET /api/crm/timeline?entity_type=&entity_no= — merged, newest-first stream.
  @Get('timeline')
  timeline(@Query('entity_type') et: string, @Query('entity_no') en: string, @CurrentUser() u: JwtUser) {
    return this.svc.timeline(et, en, u);
  }

  // GET /api/crm/feed?entity_type=&entity_no= — just the collaboration posts.
  @Get('feed')
  feed(@Query('entity_type') et: string, @Query('entity_no') en: string, @CurrentUser() u: JwtUser) {
    return this.svc.listFeed(et, en, u);
  }

  // POST /api/crm/feed — append an immutable note (+ @mention notifications).
  @Post('feed') @HttpCode(201)
  postFeed(@Body(new ZodValidationPipe(FeedPostBody)) b: any, @CurrentUser() u: JwtUser) {
    return this.svc.postFeed(b, u);
  }
}
