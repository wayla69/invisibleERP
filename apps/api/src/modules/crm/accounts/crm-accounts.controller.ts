import { Controller, Get, Post, Patch, Param, Query, Body, HttpCode } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../../common/decorators';
import { ZodValidationPipe } from '../../../common/zod-validation.pipe';
import { CrmAccountsService, AccountBody, AccountUpdateBody, MergeBody, ContactBody, ContactUpdateBody } from './crm-accounts.service';

// docs/46 Phase 5 — split VERBATIM out of the single-file crm-accounts.module.ts (service/controller/module
// convention; no DI or behaviour change).
@Controller('api/crm/accounts')
@Permissions('crm', 'exec', 'ar')
export class CrmAccountsController {
  constructor(private readonly svc: CrmAccountsService) {}

  @Post() create(@Body(new ZodValidationPipe(AccountBody)) b: z.infer<typeof AccountBody>, @CurrentUser() u: JwtUser) { return this.svc.create(b, u); }
  @Get() list(@Query('search') search: string | undefined, @CurrentUser() u: JwtUser) { return this.svc.list({ search }, u); }
  // Consequential + audited → steward duties (mirrors POST /api/customer-master/:no/merge).
  @Post(':survivorNo/merge') @HttpCode(200) @Permissions('crm', 'exec', 'masterdata')
  merge(@Param('survivorNo') no: string, @Body(new ZodValidationPipe(MergeBody)) b: z.infer<typeof MergeBody>, @CurrentUser() u: JwtUser) { return this.svc.merge(no, b.duplicate_account_no, u, b.self_approval_reason); }
  @Get(':accountNo') get(@Param('accountNo') no: string, @CurrentUser() u: JwtUser) { return this.svc.get(no, u); }
  @Patch(':accountNo') update(@Param('accountNo') no: string, @Body(new ZodValidationPipe(AccountUpdateBody)) b: z.infer<typeof AccountUpdateBody>, @CurrentUser() u: JwtUser) { return this.svc.update(no, b, u); }
}

@Controller('api/crm/contacts')
@Permissions('crm', 'exec', 'ar')
export class CrmContactsController {
  constructor(private readonly svc: CrmAccountsService) {}

  @Post() create(@Body(new ZodValidationPipe(ContactBody)) b: z.infer<typeof ContactBody>, @CurrentUser() u: JwtUser) { return this.svc.createContact(b, u); }
  @Get() list(@Query('account_no') accountNo: string | undefined, @Query('search') search: string | undefined, @CurrentUser() u: JwtUser) { return this.svc.listContacts({ account_no: accountNo, search }, u); }
  @Patch(':id') update(@Param('id') id: string, @Body(new ZodValidationPipe(ContactUpdateBody)) b: z.infer<typeof ContactUpdateBody>, @CurrentUser() u: JwtUser) { return this.svc.updateContact(+id, b, u); }
}
