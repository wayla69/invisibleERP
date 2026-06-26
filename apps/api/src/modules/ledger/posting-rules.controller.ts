import { Controller, Get, Post, Body, Query, HttpCode } from '@nestjs/common';
import { PostingService } from './posting.service';
import { Permissions } from '../../common/decorators';

@Controller('api/ledger/posting-rules')
export class PostingRulesController {
  constructor(private readonly posting: PostingService) {}

  @Get('event-types')
  @Permissions('gl_coa', 'gl_posting_rules', 'exec', 'gl_post')
  listEventTypes() {
    return this.posting.listEventTypes();
  }

  @Get()
  @Permissions('gl_coa', 'gl_posting_rules', 'exec', 'gl_post')
  listRules(@Query('eventType') eventType?: string) {
    return this.posting.listRules({ eventType });
  }

  @Post()
  @Permissions('gl_posting_rules')
  upsertRule(@Body() dto: any) {
    return this.posting.upsertRule(dto);
  }

  @Post('preview')
  @HttpCode(200)
  @Permissions('gl_posting_rules', 'gl_post', 'exec')
  preview(@Body() body: { eventType: string; amounts: Record<string, number> }) {
    return this.posting.preview(body.eventType, {
      source: 'PREVIEW', createdBy: 'system', amounts: body.amounts,
    });
  }
}
