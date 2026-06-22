import { Controller, Get, Post, Body, Param, ParseIntPipe, Query, HttpCode } from '@nestjs/common';
import { CpqService } from './cpq.service';
import { CurrentUser, Permissions } from '../../common/decorators';
import type { JwtUser } from '../../common/decorators';

@Controller('api/cpq')
export class CpqController {
  constructor(private readonly svc: CpqService) {}

  @Get('configs')
  @Permissions('exec')
  listConfigs(@CurrentUser() user: JwtUser) { return this.svc.listConfigs(user); }

  @Post('configs')
  @Permissions('masterdata')
  createConfig(@Body() dto: any, @CurrentUser() user: JwtUser) { return this.svc.createConfig(dto, user); }

  @Post('configs/:id/options')
  @Permissions('masterdata')
  addOption(@Param('id', ParseIntPipe) id: number, @Body() dto: any, @CurrentUser() user: JwtUser) { return this.svc.addOption(id, dto, user); }

  @Post('configs/:id/rules')
  @Permissions('masterdata')
  createRule(@Param('id', ParseIntPipe) id: number, @Body() dto: any, @CurrentUser() user: JwtUser) { return this.svc.createRule({ ...dto, config_id: id }, user); }

  @Get('quotes')
  @Permissions('exec')
  listQuotes(@Query('status') status?: string, @CurrentUser() user?: JwtUser) { return this.svc.listQuotes({ status }, user!); }

  @Post('quotes')
  @Permissions('exec')
  createQuote(@Body() dto: any, @CurrentUser() user: JwtUser) { return this.svc.createQuote(dto, user); }

  @Get('quotes/:id/lines')
  @Permissions('exec')
  getLines(@Param('id', ParseIntPipe) id: number) { return this.svc.getQuoteLines(id); }

  @Post('quotes/:id/send')
  @Permissions('exec')
  @HttpCode(200)
  send(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: JwtUser) { return this.svc.sendQuote(id, user); }

  @Post('quotes/:id/accept')
  @Permissions('exec')
  @HttpCode(200)
  accept(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: JwtUser) { return this.svc.acceptQuote(id, user); }

  @Post('quotes/:id/reject')
  @Permissions('exec')
  @HttpCode(200)
  reject(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: JwtUser) { return this.svc.rejectQuote(id, user); }
}
