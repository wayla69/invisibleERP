import { Controller, Get, Post, Delete, Param, Body } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { ImagesService } from './images.service';

const UploadBody = z.object({ data_url: z.string().min(1) });

@Controller('api/images')
@Permissions('images', 'masterdata')
export class ImagesController {
  constructor(private readonly svc: ImagesService) {}

  @Get() list() { return this.svc.list(); }
  @Get(':itemId') get(@Param('itemId') itemId: string) { return this.svc.get(itemId); }
  @Post(':itemId') upload(@Param('itemId') itemId: string, @Body(new ZodValidationPipe(UploadBody)) b: z.infer<typeof UploadBody>, @CurrentUser() u: JwtUser) { return this.svc.upsert(itemId, b.data_url, u); }
  @Delete(':itemId') remove(@Param('itemId') itemId: string) { return this.svc.remove(itemId); }
}
