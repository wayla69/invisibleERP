import { Controller, Get, Query, HttpCode } from '@nestjs/common';
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

  @Get('callback')
  @Public()
  @NoTx()
  @HttpCode(200)
  callback(@Query('state') state?: string, @Query('code') code?: string, @Query('id_token') idToken?: string) {
    return this.svc.callback({ state, code, id_token: idToken });
  }
}
