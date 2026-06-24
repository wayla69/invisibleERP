import { Controller, Get, Post, Put, Patch, Delete, Param, Query, Body, HttpCode, UseGuards } from '@nestjs/common';
import { Public, CurrentUser, type JwtUser } from '../../common/decorators';
import { ScimAuthGuard } from './scim.guard';
import { ScimService } from './scim.service';

// SCIM 2.0 provisioning surface. @Public so the global JWT guard is skipped; the per-tenant SCIM
// bearer token is enforced by ScimAuthGuard (which sets the tenant-scoped principal).
@Controller('scim/v2')
@Public()
@UseGuards(ScimAuthGuard)
export class ScimController {
  constructor(private readonly svc: ScimService) {}

  @Get('ServiceProviderConfig')
  spc() { return this.svc.serviceProviderConfig(); }

  @Get('Users')
  list(@CurrentUser() u: JwtUser, @Query('filter') filter?: string, @Query('startIndex') startIndex?: string, @Query('count') count?: string) {
    return this.svc.list(u, { filter, startIndex, count });
  }

  @Get('Users/:id')
  get(@CurrentUser() u: JwtUser, @Param('id') id: string) { return this.svc.get(u, id); }

  @Post('Users')
  @HttpCode(201)
  create(@CurrentUser() u: JwtUser, @Body() body: any) { return this.svc.create(u, body); }

  @Put('Users/:id')
  replace(@CurrentUser() u: JwtUser, @Param('id') id: string, @Body() body: any) { return this.svc.replace(u, id, body); }

  @Patch('Users/:id')
  patch(@CurrentUser() u: JwtUser, @Param('id') id: string, @Body() body: any) { return this.svc.patch(u, id, body); }

  @Delete('Users/:id')
  @HttpCode(204)
  remove(@CurrentUser() u: JwtUser, @Param('id') id: string) { return this.svc.deactivate(u, id); }
}
