import { Module } from '@nestjs/common';
import { BiLiveService } from './bi-live.service';

// The real-time event bus (BiLiveService) lives in its own module so it is a SINGLE shared instance across
// the app: BiModule serves the SSE stream / recent feed from it, and ProjectsModule publishes PMO action
// events to it (PMO-1) — both import this module rather than re-providing the service, which would split it
// into two buffers. Keeping it standalone also avoids a Projects↔Bi circular import (BiModule imports
// ProjectsModule for the project_evm report type).
@Module({ providers: [BiLiveService], exports: [BiLiveService] })
export class BiLiveModule {}
