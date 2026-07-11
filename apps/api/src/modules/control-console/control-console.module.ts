import { Module } from '@nestjs/common';
import { ControlConsoleService } from './control-console.service';
import { ControlConsoleController } from './control-console.controller';

// GRC-1 / ITGC-MON-01 — auditor-facing Control Console: the RCM catalogue (loaded from
// compliance/rcm-catalog.json at init) + tenant-scoped ToE test-run evidence. DRIZZLE is global; no other
// module dependencies. Kept separate from ControlsModule (CCM detectors) though both share the api/controls
// route prefix.
@Module({ controllers: [ControlConsoleController], providers: [ControlConsoleService], exports: [ControlConsoleService] })
export class ControlConsoleModule {}
