import { Controller, Get, Post, Patch, Body, Param, Query, ParseIntPipe } from '@nestjs/common';
import { BranchService, type CreateBranchDto, type UpdateBranchDto } from './branch.service';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';

@Controller('api/branches')
export class BranchController {
  constructor(private readonly svc: BranchService) {}

  @Get() @Permissions('branch', 'exec')
  list(@CurrentUser() user: JwtUser) {
    return this.svc.listBranches(user);
  }

  @Post() @Permissions('branch')
  create(@Body() dto: CreateBranchDto, @CurrentUser() user: JwtUser) {
    return this.svc.createBranch(dto, user);
  }

  @Patch(':id') @Permissions('branch')
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateBranchDto, @CurrentUser() user: JwtUser) {
    return this.svc.updateBranch(id, dto, user);
  }

  // HQ consolidated POS totals per branch. ?from=YYYY-MM-DD&to=YYYY-MM-DD
  @Get('consolidated') @Permissions('branch', 'exec')
  consolidated(@CurrentUser() user: JwtUser, @Query('from') from?: string, @Query('to') to?: string) {
    return this.svc.consolidatedSales(user, from, to);
  }

  // Master-data bundle for an offline branch POS to cache (catalog + prices + promos).
  @Get('master-bundle') @Permissions('branch', 'cust_pos')
  masterBundle(@CurrentUser() user: JwtUser) {
    return this.svc.masterBundle(user);
  }
}
