import { Controller, Get, Post, Query, Body, HttpCode, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { Public, NoTx } from '../../common/decorators';
import { setAuthCookies } from '../../common/cookies';
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

  // The assertion is taken from the request BODY, not the query string, so the sensitive
  // id_token/authorization code never lands in a URL (and thus not in logs/history/referer). The web
  // /sso/callback page forwards the IdP's redirect query verbatim as `query`; we parse it here from the
  // body. Direct fields (state/code/id_token) are also accepted (used by tests/non-browser clients).
  @Post('callback')
  @Public()
  @NoTx()
  @HttpCode(200)
  async callback(@Body() body: { query?: string; state?: string; code?: string; id_token?: string }, @Res({ passthrough: true }) reply: FastifyReply) {
    let { state, code, id_token } = body ?? {};
    if (body?.query && !state && !code && !id_token) {
      const q = new URLSearchParams(body.query);
      state = q.get('state') ?? undefined;
      code = q.get('code') ?? undefined;
      id_token = q.get('id_token') ?? undefined;
    }
    const res: any = await this.svc.callback({ state, code, id_token });
    if (res?.token) setAuthCookies(reply, res.token); // browser session cookie (token also in body for non-browser)
    return res;
  }
}
