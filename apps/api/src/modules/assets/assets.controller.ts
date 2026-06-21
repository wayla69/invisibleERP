import { Controller, Get, Post, Patch, Param, Query, Body } from '@nestjs/common';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { AssetsService } from './assets.service';
import { CreateCategoryBody, AcquireAssetBody, RunDepreciationBody, DisposeAssetBody, type CreateCategoryDto, type AcquireAssetDto, type DisposeAssetDto } from './dto';

@Controller('api/assets')
@Permissions('exec', 'creditors')
export class AssetsController {
  constructor(private readonly svc: AssetsService) {}

  @Post('categories') createCategory(@Body(new ZodValidationPipe(CreateCategoryBody)) b: CreateCategoryDto, @CurrentUser() u: JwtUser) { return this.svc.createCategory(b, u); }
  @Get('categories') listCategories(@CurrentUser() u: JwtUser) { return this.svc.listCategories(u); }

  @Post() acquire(@Body(new ZodValidationPipe(AcquireAssetBody)) b: AcquireAssetDto, @CurrentUser() u: JwtUser) { return this.svc.acquire(b, u); }
  @Get() register(@Query('status') status: string | undefined, @CurrentUser() u: JwtUser) { return this.svc.assetRegister(u, status); }
  @Get(':assetNo/schedule') schedule(@Param('assetNo') no: string, @CurrentUser() u: JwtUser) { return this.svc.depreciationSchedule(u, no); }
  @Patch(':assetNo/dispose') dispose(@Param('assetNo') no: string, @Body(new ZodValidationPipe(DisposeAssetBody)) b: DisposeAssetDto, @CurrentUser() u: JwtUser) { return this.svc.dispose(no, b, u); }

  @Post('depreciation/run') runDep(@Body(new ZodValidationPipe(RunDepreciationBody)) b: { period: string }, @CurrentUser() u: JwtUser) { return this.svc.runDepreciation(b.period, u); }
  @Get('depreciation/runs') runs(@Query('limit') limit: string | undefined, @CurrentUser() u: JwtUser) { return this.svc.listRuns(u, limit ? +limit : 50); }
}
