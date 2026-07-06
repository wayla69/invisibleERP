import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { RealEstateService, type CreateDevDto, type AddUnitDto, type BookDto, type CreateContractDto, type PayDto } from './realestate.service';

const DevBody = z.object({ dev_code: z.string().min(1), name: z.string().min(1), location: z.string().optional() });
const UnitBody = z.object({ unit_no: z.string().min(1), unit_type: z.string().optional(), area_sqm: z.number().nonnegative().optional(), floor: z.string().optional(), list_price: z.number().positive(), cost: z.number().nonnegative().optional() });
const BookBody = z.object({ dev_code: z.string().min(1), unit_no: z.string().min(1), buyer_name: z.string().optional(), deposit: z.number().nonnegative(), expires_on: z.string().optional() });
const ContractBody = z.object({ dev_code: z.string().min(1), unit_no: z.string().min(1), booking_no: z.string().optional(), buyer_name: z.string().optional(), discount: z.number().min(0).optional(), down_payment: z.number().min(0), installment_count: z.number().int().min(0) });
const PayBody = z.object({ amount: z.number().positive() });

// Real-estate developer vertical (docs/35 P4, RE-01/02/03). Permission-gated: a sales agent (re_sales)
// manages developments/units, books units, drafts contracts and records installment payments; an independent
// approver (re_contract_approve, ≠ the drafter) approves the contract (maker-checker, RE-02). A non-property
// tenant simply never grants these permissions → the vertical is invisible.
@Controller('api/realestate')
export class RealEstateController {
  constructor(private readonly svc: RealEstateService) {}

  @Post('developments')
  @Permissions('re_sales', 'exec')
  createDev(@Body(new ZodValidationPipe(DevBody)) b: CreateDevDto, @CurrentUser() u: JwtUser) { return this.svc.createDevelopment(b, u); }

  @Post('developments/:code/units')
  @Permissions('re_sales', 'exec')
  addUnit(@Param('code') code: string, @Body(new ZodValidationPipe(UnitBody)) b: AddUnitDto, @CurrentUser() u: JwtUser) { return this.svc.addUnit(code, b, u); }

  @Get('developments/:code/units')
  @Permissions('re_sales', 'exec', 'dashboard')
  units(@Param('code') code: string) { return this.svc.listUnits(code); }

  @Post('bookings')
  @Permissions('re_sales', 'exec')
  book(@Body(new ZodValidationPipe(BookBody)) b: BookDto, @CurrentUser() u: JwtUser) { return this.svc.book(b, u); }

  @Post('contracts')
  @Permissions('re_sales', 'exec')
  createContract(@Body(new ZodValidationPipe(ContractBody)) b: CreateContractDto, @CurrentUser() u: JwtUser) { return this.svc.createContract(b, u); }

  // Approve a draft contract (independent approver ≠ drafter, RE-02). Static segment — never collides with :no.
  @Post('contracts/:no/approve')
  @Permissions('re_contract_approve', 'exec')
  approve(@Param('no') no: string, @CurrentUser() u: JwtUser) { return this.svc.approveContract(no, u); }

  @Post('installments/:id/pay')
  @Permissions('re_sales', 'ar', 'exec')
  pay(@Param('id') id: string, @Body(new ZodValidationPipe(PayBody)) b: PayDto, @CurrentUser() u: JwtUser) { return this.svc.payInstallment(Number(id), b, u); }

  // Ownership transfer (RE-04) — authorised, fully-settled-only; recognises revenue + relieves the unit cost.
  @Post('contracts/:no/transfer')
  @Permissions('re_transfer', 'exec')
  transfer(@Param('no') no: string, @CurrentUser() u: JwtUser) { return this.svc.transferOwnership(no, u); }

  @Get('contracts/:no')
  @Permissions('re_sales', 're_contract_approve', 'exec')
  contract(@Param('no') no: string) { return this.svc.getContract(no); }
}
