import { Controller, Get, Headers, Query } from '@nestjs/common';
import { HubSyncService } from './hub-sync.service';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';

// Store-hub snapshot export (docs/41 Phase 1). Read-only; fail-closed behind HUB_SYNC_SECRET.
// `?include_credentials=1` additionally requires the X-Hub-Sync-Key header to match the secret.
@Controller('api/hub')
export class HubController {
  constructor(private readonly svc: HubSyncService) {}

  @Get('snapshot') @Permissions('branch', 'exec')
  snapshot(
    @CurrentUser() user: JwtUser,
    @Query('include_credentials') includeCredentials?: string,
    @Headers('x-hub-sync-key') syncKey?: string,
  ) {
    return this.svc.exportSnapshot(user, {
      includeCredentials: includeCredentials === '1' || includeCredentials === 'true',
      syncKey: syncKey ?? null,
    });
  }
}
