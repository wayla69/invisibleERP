import { Controller, Get, Post, Patch, Body, Param, Query } from '@nestjs/common';
import { CoaService } from './coa.service';
import { Permissions } from '../../common/decorators';

@Controller('ledger/accounts')
export class CoaController {
  constructor(private readonly coa: CoaService) {}

  @Get()
  @Permissions('gl_coa', 'exec', 'gl_post', 'creditors', 'ar')
  list(@Query('all') all?: string) {
    return this.coa.listTree({ all: all === 'true' });
  }

  @Post()
  @Permissions('gl_coa')
  create(@Body() dto: any) {
    return this.coa.createAccount(dto);
  }

  @Patch(':code')
  @Permissions('gl_coa')
  update(@Param('code') code: string, @Body() dto: any) {
    return this.coa.updateAccount(code, dto);
  }

  @Post(':code/deactivate')
  @Permissions('gl_coa')
  deactivate(@Param('code') code: string) {
    return this.coa.deactivateAccount(code);
  }
}
