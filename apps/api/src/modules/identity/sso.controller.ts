import { Controller, Get, Post, Query, Body, HttpCode } from '@nestjs/common';
import { Public, NoTx } from '../../common/decorators';
import { SsoService } from './sso.service';

// Public SSO endpoints (no prior session). authorize → IdP redirect URL; callback → verified session.
@Controller('api/auth/sso')
export class SsoController {
  constructor(private readonly svc: SsoService) {}

  @Get('authorize')
  @Public()
  @NoTx()
  authorize(@Query('tenant') tenant: string) {
    return this.svc.authorize(String(tenant ?? ''));
  }

  // The assertion (state + code/id_token) is taken from the request BODY, not the query string, so the
  // sensitive id_token/authorization code never lands in a URL (and thus not in logs/history/referer).
  // The browser-facing redirect_uri is the web /sso/callback page, which forwards these via this POST.
  @Post('callback')
  @Public()
  @NoTx()
  @HttpCode(200)
  callback(@Body() body: { state?: string; code?: string; id_token?: string }) {
    return this.svc.callback({ state: body?.state, code: body?.code, id_token: body?.id_token });
  }
}
