import { Controller, Get, Put, Post, Body, HttpCode } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { IdentityConfigService } from './identity-config.service';

const ConfigBody = z.object({
  sso_enabled: z.boolean().optional(),
  oidc_issuer: z.string().optional(),
  oidc_client_id: z.string().optional(),
  oidc_client_secret: z.string().optional(),
  oidc_redirect_uri: z.string().optional(),
  default_role: z.string().optional(),
  scim_enabled: z.boolean().optional(),
});

// Tenant admin configures its IdP (SSO) + SCIM. Gated by `users`. Secrets are write-only.
@Controller('api/platform/identity')
@Permissions('users')
export class IdentityController {
  constructor(private readonly svc: IdentityConfigService) {}

  @Get()
  get(@CurrentUser() u: JwtUser) { return this.svc.get(u); }

  @Put()
  @HttpCode(200)
  upsert(@Body(new ZodValidationPipe(ConfigBody)) b: z.infer<typeof ConfigBody>, @CurrentUser() u: JwtUser) {
    return this.svc.upsert(b, u);
  }

  @Post('scim-token')
  @HttpCode(200)
  rotateScim(@CurrentUser() u: JwtUser) { return this.svc.rotateScimToken(u); }
}
