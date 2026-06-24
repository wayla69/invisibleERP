import { Controller, Get, Post, Body } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { MigrationService } from './migration.service';

const DryRunBody = z.object({ source: z.string().min(1), entity: z.string().min(1), rows: z.array(z.any()) });

// E2 (Phase 27) — data-migration toolkit. Dry-run validation only (preview before the Phase-7 commit); no GL.
@Controller('api/migration')
export class MigrationController {
  constructor(private readonly svc: MigrationService) {}

  @Get('sources') @Permissions('masterdata', 'users', 'exec') sources() { return this.svc.sources(); }

  @Post('dry-run') @Permissions('masterdata', 'users', 'exec')
  dryRun(@Body(new ZodValidationPipe(DryRunBody)) b: any, @CurrentUser() u: JwtUser) { return this.svc.dryRun(u, b.source, b.entity, b.rows); }

  @Get('jobs') @Permissions('masterdata', 'users', 'exec') jobs(@CurrentUser() u: JwtUser) { return this.svc.jobs(u); }
}
