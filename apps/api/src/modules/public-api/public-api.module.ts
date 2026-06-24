import { Module } from '@nestjs/common';
import { PublicApiController } from './public-api.controller';
import { PublicApiService } from './public-api.service';
import { PublicApiGuard } from './public-api.guard';

// Public REST API (v1). Auth is handled by the global JwtAuthGuard (API-key path); this module
// adds the versioned read surface, the scope/rate guard, and the OpenAPI document.
@Module({
  controllers: [PublicApiController],
  providers: [PublicApiService, PublicApiGuard],
})
export class PublicApiModule {}
