import { Controller, Get, Post, Param, Body } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { ControlConsoleService } from './control-console.service';

const TestRunBody = z.object({
  result: z.enum(['pass', 'fail', 'na']).optional(),
  harness: z.string().optional(),
  checks_passed: z.number().int().nonnegative().optional(),
  checks_total: z.number().int().nonnegative().optional(),
  evidence_ref: z.string().optional(),
  notes: z.string().optional(),
});

// GRC-1 / ITGC-MON-01 — Control Console (auditor-facing RCM + ToE evidence). Read-only over the control
// catalogue (platform reference data) + tenant-scoped ToE test-runs. Gated to the compliance/exec function
// (`exec`/`users`). Distinct routes from ControlsController's api/controls/{catalog,scan,findings}.
@Controller('api/controls')
export class ControlConsoleController {
  constructor(private readonly svc: ControlConsoleService) {}

  // The RCM catalogue: controls (17 fields) + family roll-up + census summary.
  @Get('rcm') @Permissions('exec', 'users')
  rcm() { return this.svc.rcm(); }

  // A single control's detail: fields + latest/historical ToE test-runs + linked CCM findings + audit evidence.
  @Get('rcm/:controlId') @Permissions('exec', 'users')
  detail(@Param('controlId') controlId: string) { return this.svc.rcmDetail(controlId); }

  // Record a test-of-effectiveness run against a control.
  @Post('rcm/:controlId/test-run') @Permissions('exec', 'users')
  record(@Param('controlId') controlId: string, @Body(new ZodValidationPipe(TestRunBody)) b: z.infer<typeof TestRunBody>, @CurrentUser() u: JwtUser) {
    return this.svc.recordTestRun(u, controlId, b);
  }
}
