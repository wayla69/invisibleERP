import { Controller, Get, Post, Patch, Param, Query, Body } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { PosService, type CreateOrderDto } from './pos.service';

const CreateOrderBody = z.object({
  customer_name: z.string().optional(),
  items: z.array(z.object({
    item_id: z.string().min(1),
    item_description: z.string().optional(),
    order_qty: z.number().positive(),
    stock_uom: z.string().optional(),
    unit_price: z.number().nonnegative(),
  })).min(1),
});

const UpdateStatusBody = z.object({
  status: z.string().min(1),
  estimated_delivery: z.string().nullish(),
});

@Controller('api/pos')
export class PosController {
  constructor(private readonly svc: PosService) {}

  @Get('summary') @Permissions('pos', 'dashboard')
  summary(@Query('start_date') start: string, @Query('end_date') end: string) { return this.svc.summary(start, end); }

  @Get('orders') @Permissions('pos', 'order_mgt', 'dashboard')
  orders(@Query('limit') limit?: string, @Query('offset') offset?: string, @Query('status') status?: string) {
    return this.svc.orders(limit ? +limit : 20, offset ? +offset : 0, status);
  }

  @Get('orders/:saleNo') @Permissions('pos', 'order_mgt', 'dashboard')
  orderDetail(@Param('saleNo') saleNo: string) { return this.svc.orderDetail(saleNo); }

  @Get('sessions') @Permissions('pos', 'dashboard')
  sessions() { return this.svc.sessions(); }

  // WRITE
  @Post('orders') @Permissions('pos', 'order_cust')
  createOrder(@Body(new ZodValidationPipe(CreateOrderBody)) body: CreateOrderDto, @CurrentUser() user: JwtUser) {
    return this.svc.createOrder(body, user);
  }
}

@Controller('api/orders')
export class OrdersController {
  constructor(private readonly svc: PosService) {}

  @Patch(':orderNo/status') @Permissions('order_mgt', 'pos')
  updateStatus(
    @Param('orderNo') orderNo: string,
    @Body(new ZodValidationPipe(UpdateStatusBody)) body: { status: string; estimated_delivery?: string | null },
    @CurrentUser() user: JwtUser,
  ) {
    return this.svc.updateOrderStatus(orderNo, body.status, body.estimated_delivery ?? null, user);
  }
}
