import { Controller, Get, Post, Patch, Delete, Param, Query, Body } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { CustomersService } from './customers.service';
import {
  CustomerMasterService,
  CreateCustomerBody, LinkCustomerBody, AddressBody, ContactBody, ParentBody, MergeCustomerBody, RelationshipBody, UpdateCustomerBody,
} from './customer-master.service';

// docs/46 Phase 5 — split VERBATIM out of the single-file customers.module.ts (service/controller/module
// convention; no DI or behaviour change).
@Controller('api/customers')
export class CustomersController {
  constructor(private readonly svc: CustomersService) {}

  @Get(':name')
  @Permissions('crm', 'dashboard', 'ar')
  detail(@Param('name') name: string) {
    return this.svc.detail(name);
  }
}

@Controller('api/customer-master')
@Permissions('crm', 'exec', 'ar')
export class CustomerMasterController {
  constructor(private readonly svc: CustomerMasterService) {}

  @Post() create(@Body(new ZodValidationPipe(CreateCustomerBody)) b: z.infer<typeof CreateCustomerBody>, @CurrentUser() u: JwtUser) { return this.svc.create(b, u); }
  @Get() list(@Query('search') search: string | undefined, @CurrentUser() u: JwtUser) { return this.svc.list({ search }, u); }
  // Static routes BEFORE the ':customerNo' param route so they aren't captured by it.
  @Get('duplicates') findDuplicates(@CurrentUser() u: JwtUser) { return this.svc.findDuplicates(u); }
  @Post(':survivorNo/merge') @Permissions('crm', 'exec', 'masterdata')
  merge(@Param('survivorNo') no: string, @Body(new ZodValidationPipe(MergeCustomerBody)) b: z.infer<typeof MergeCustomerBody>, @CurrentUser() u: JwtUser) { return this.svc.merge(no, b.duplicate_customer_no, u); }
  @Get(':customerNo') get(@Param('customerNo') no: string, @CurrentUser() u: JwtUser) { return this.svc.get(no, u); }
  @Get(':customerNo/360') view360(@Param('customerNo') no: string, @CurrentUser() u: JwtUser) { return this.svc.view360(no, u); }
  @Get(':customerNo/history') history(@Param('customerNo') no: string, @CurrentUser() u: JwtUser) { return this.svc.history(no, u); }
  @Post(':customerNo/relationships') addRelationship(@Param('customerNo') no: string, @Body(new ZodValidationPipe(RelationshipBody)) b: z.infer<typeof RelationshipBody>, @CurrentUser() u: JwtUser) { return this.svc.addRelationship(no, b, u); }
  @Get(':customerNo/relationships') listRelationships(@Param('customerNo') no: string, @CurrentUser() u: JwtUser) { return this.svc.listRelationships(no, u); }
  @Delete(':customerNo/relationships/:relId') deleteRelationship(@Param('customerNo') no: string, @Param('relId') relId: string, @CurrentUser() u: JwtUser) { return this.svc.deleteRelationship(no, +relId, u); }
  @Patch(':customerNo') update(@Param('customerNo') no: string, @Body(new ZodValidationPipe(UpdateCustomerBody)) b: z.infer<typeof UpdateCustomerBody>, @CurrentUser() u: JwtUser) { return this.svc.update(no, b, u); }
  @Patch(':customerNo/link') link(@Param('customerNo') no: string, @Body(new ZodValidationPipe(LinkCustomerBody)) b: z.infer<typeof LinkCustomerBody>, @CurrentUser() u: JwtUser) { return this.svc.link(no, b, u); }
  @Patch(':customerNo/parent') setParent(@Param('customerNo') no: string, @Body(new ZodValidationPipe(ParentBody)) b: z.infer<typeof ParentBody>, @CurrentUser() u: JwtUser) { return this.svc.setParent(no, b, u); }
  @Post(':customerNo/addresses') addAddress(@Param('customerNo') no: string, @Body(new ZodValidationPipe(AddressBody)) b: z.infer<typeof AddressBody>, @CurrentUser() u: JwtUser) { return this.svc.addAddress(no, b, u); }
  @Get(':customerNo/addresses') listAddresses(@Param('customerNo') no: string, @CurrentUser() u: JwtUser) { return this.svc.listAddresses(no, u); }
  @Delete(':customerNo/addresses/:addressId') deleteAddress(@Param('customerNo') no: string, @Param('addressId') addressId: string, @CurrentUser() u: JwtUser) { return this.svc.deleteAddress(no, +addressId, u); }
  @Post(':customerNo/contacts') addContact(@Param('customerNo') no: string, @Body(new ZodValidationPipe(ContactBody)) b: z.infer<typeof ContactBody>, @CurrentUser() u: JwtUser) { return this.svc.addContact(no, b, u); }
  @Get(':customerNo/contacts') listContacts(@Param('customerNo') no: string, @CurrentUser() u: JwtUser) { return this.svc.listContacts(no, u); }
  @Delete(':customerNo/contacts/:contactId') deleteContact(@Param('customerNo') no: string, @Param('contactId') contactId: string, @CurrentUser() u: JwtUser) { return this.svc.deleteContact(no, +contactId, u); }
}
