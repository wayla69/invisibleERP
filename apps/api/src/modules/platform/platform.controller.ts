import { Controller, Get, Post, Delete, Param, Body, Query, ParseIntPipe, HttpCode } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { ApiKeyService, type IssueKeyDto } from './api-key.service';
import { WebhookService, type RegisterWebhookDto } from './webhook.service';
import { MfaService } from './mfa.service';

const IssueKeyBody = z.object({ name: z.string().min(1), scopes: z.array(z.string()).optional() });
const RegisterWebhookBody = z.object({ url: z.string().url(), events: z.array(z.string()).optional() });
const MfaVerifyBody = z.object({ token: z.string().min(1) });

@Controller('api/platform')
@Permissions('users')
export class PlatformController {
  constructor(
    private readonly apiKeys: ApiKeyService,
    private readonly webhooks: WebhookService,
    private readonly mfa: MfaService,
  ) {}

  // ── API keys ──────────────────────────────────────────────
  @Post('api-keys')
  issueKey(@Body(new ZodValidationPipe(IssueKeyBody)) b: IssueKeyDto, @CurrentUser() u: JwtUser) {
    return this.apiKeys.issue(b, u);
  }

  @Get('api-keys')
  listKeys(@CurrentUser() u: JwtUser) {
    return this.apiKeys.listForUser(u);
  }

  @Delete('api-keys/:id')
  revokeKey(@Param('id') id: string, @CurrentUser() u: JwtUser) {
    return this.apiKeys.revoke(parseInt(id, 10), u);
  }

  // ── Webhooks ──────────────────────────────────────────────
  @Get('webhooks/events')
  webhookEvents() {
    return this.webhooks.events();
  }

  @Post('webhooks')
  registerWebhook(@Body(new ZodValidationPipe(RegisterWebhookBody)) b: RegisterWebhookDto, @CurrentUser() u: JwtUser) {
    return this.webhooks.register(b, u);
  }

  @Get('webhooks')
  listWebhooks(@CurrentUser() u: JwtUser) {
    return this.webhooks.listForUser(u);
  }

  @Delete('webhooks/:id')
  removeWebhook(@Param('id', ParseIntPipe) id: number, @CurrentUser() u: JwtUser) {
    return this.webhooks.remove(id, u);
  }

  @Get('webhooks/deliveries')
  webhookDeliveries(@Query('limit') limit: string | undefined, @CurrentUser() u: JwtUser) {
    return this.webhooks.deliveries(u, limit ? Math.min(parseInt(limit, 10) || 100, 500) : 100);
  }

  @Post('webhooks/deliveries/:id/redeliver')
  @HttpCode(200)
  redeliver(@Param('id', ParseIntPipe) id: number, @CurrentUser() u: JwtUser) {
    return this.webhooks.redeliver(id, u);
  }

  @Post('webhooks/dispatch')
  @HttpCode(200)
  dispatch(@CurrentUser() u: JwtUser) {
    return this.webhooks.dispatchPending(u);
  }

  // ── MFA (TOTP) ────────────────────────────────────────────
  @Post('mfa/setup')
  mfaSetup(@CurrentUser() u: JwtUser) {
    return this.mfa.setup(u);
  }

  @Post('mfa/verify')
  mfaVerify(@Body(new ZodValidationPipe(MfaVerifyBody)) b: { token: string }, @CurrentUser() u: JwtUser) {
    return this.mfa.verify(u, b.token);
  }
}
