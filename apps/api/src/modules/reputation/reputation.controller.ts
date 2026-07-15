import { Controller, Get, Post, Put, Delete, Body, Param, Query, ParseIntPipe, BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import { Public, NoTx, CurrentUser, Permissions } from '../../common/decorators';
import type { JwtUser } from '../../common/decorators';
import { GoogleOAuthService, type ReputationPlatform } from './google-oauth.service';
import { ReputationConnectionsService } from './reputation-connections.service';
import { ReputationReviewSyncService } from './reputation-review-sync.service';
import { ReputationAnalyticsSyncService } from './reputation-analytics-sync.service';
import { ReputationReadsService } from './reputation-reads.service';
import { ReputationSlaService } from './reputation-sla.service';

const PLATFORMS = ['google_maps', 'google_analytics'] as const;
const TargetsBody = z.object({ targets: z.array(z.object({ ref: z.string().min(1), label: z.string() })) });
const ReplyBody = z.object({ comment: z.string().min(1).max(4000) });
const ResponseSettingsBody = z.object({
  slaRatingThreshold: z.number().int().min(1).max(5).optional(),
  slaHours: z.number().int().min(1).max(720).optional(),
});

function parsePlatform(v: string | undefined): ReputationPlatform {
  if (!v || !(PLATFORMS as readonly string[]).includes(v)) throw new BadRequestException({ code: 'BAD_PLATFORM', message: 'platform must be google_maps or google_analytics', messageTh: 'platform ต้องเป็น google_maps หรือ google_analytics' });
  return v as ReputationPlatform;
}

// docs/47 — reputation & external analytics ingestion. OAuth start/callback are the ONLY public routes
// (the callback resolves tenant/user purely from its single-use state row, mirroring /api/auth/sso).
// Everything else requires marketing/exec, same gate as the audience-export/marketing-roi reads (docs/45).
@Controller('api/reputation')
export class ReputationController {
  constructor(
    private readonly oauth: GoogleOAuthService,
    private readonly connections: ReputationConnectionsService,
    private readonly reviewSync: ReputationReviewSyncService,
    private readonly analyticsSync: ReputationAnalyticsSyncService,
    private readonly reads: ReputationReadsService,
    private readonly sla: ReputationSlaService,
  ) {}

  @Get('oauth/start')
  @Permissions('marketing', 'exec')
  oauthStart(@Query('platform') platform: string | undefined, @CurrentUser() user: JwtUser) {
    return this.oauth.start(user, parsePlatform(platform));
  }

  // The web callback page forwards window.location.search VERBATIM in the body — see google-oauth.service
  // for why this avoids the js/sensitive-get-query (CWE-598) sink (same pattern as /api/auth/sso/callback).
  @Post('oauth/callback')
  @Public()
  @NoTx()
  oauthCallback(@Body() body: { query?: string; state?: string; code?: string }) {
    return this.oauth.callback(body ?? {});
  }

  @Get('connections')
  @Permissions('marketing', 'exec')
  listConnections(@CurrentUser() user: JwtUser) {
    return this.connections.list(user);
  }

  @Get('connections/:id/targets')
  @Permissions('marketing', 'exec')
  listTargets(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: JwtUser) {
    return this.connections.listTargets(user, id);
  }

  @Put('connections/:id/targets')
  @Permissions('marketing', 'exec')
  setTargets(@Param('id', ParseIntPipe) id: number, @Body() body: unknown, @CurrentUser() user: JwtUser) {
    const dto = TargetsBody.parse(body);
    return this.connections.setTargets(user, id, dto.targets);
  }

  @Delete('connections/:id')
  @Permissions('marketing', 'exec')
  revoke(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: JwtUser) {
    return this.connections.revoke(user, id);
  }

  // Manual "sync now" — same logic the scheduled reports run, triggered on demand for immediate UI feedback.
  @Post('sync/:platform')
  @Permissions('marketing', 'exec')
  syncNow(@Param('platform') platform: string, @CurrentUser() user: JwtUser) {
    const p = parsePlatform(platform);
    return p === 'google_maps' ? this.reviewSync.syncTenant(user) : this.analyticsSync.syncTenant(user);
  }

  @Post('reviews/:id/reply')
  @Permissions('marketing', 'exec')
  reply(@Param('id', ParseIntPipe) id: number, @Body() body: unknown, @CurrentUser() user: JwtUser) {
    const dto = ReplyBody.parse(body);
    return this.reviewSync.reply(user, id, dto.comment);
  }

  @Get('reviews')
  @Permissions('marketing', 'exec')
  reviews(@Query('needs_attention') needsAttention: string | undefined, @Query('limit') limit: string | undefined, @CurrentUser() user: JwtUser) {
    return this.reads.reviews(user, { needsAttention: needsAttention === '1' || needsAttention === 'true', limit: limit != null ? Number(limit) : undefined });
  }

  @Get('analytics')
  @Permissions('marketing', 'exec')
  analytics(@Query('property_ref') propertyRef: string | undefined, @Query('days') days: string | undefined, @CurrentUser() user: JwtUser) {
    return this.reads.analytics(user, { propertyRef, days: days != null ? Number(days) : undefined });
  }

  // ── Review-response SLA governance (MKT-16) ──────────────────────────────────────────────────────────
  @Get('response-sla')
  @Permissions('marketing', 'exec')
  responseSla(@CurrentUser() user: JwtUser) {
    return this.sla.responseSla(user);
  }

  @Get('response-settings')
  @Permissions('marketing', 'exec')
  getResponseSettings(@CurrentUser() user: JwtUser) {
    return this.sla.getSettings(user);
  }

  @Put('response-settings')
  @Permissions('marketing', 'exec')
  putResponseSettings(@Body() body: unknown, @CurrentUser() user: JwtUser) {
    const dto = ResponseSettingsBody.parse(body);
    return this.sla.putSettings(user, dto);
  }
}
