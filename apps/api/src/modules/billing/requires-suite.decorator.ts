import { SetMetadata } from '@nestjs/common';
import type { SuiteKey } from '@ierp/shared';

// Metadata key used by PlanGuard to read the required premium SUITE from route/class metadata.
export const REQUIRES_SUITE_KEY = 'requiresSuite';

// Gate a controller (class) or handler behind a premium/add-on SUITE that has no coarse permission token of
// its own (Manufacturing / Projects / HCM / Real-estate — see @ierp/shared TOKENLESS_SUITES). PlanGuard
// blocks (403 SUITE_NOT_ENTITLED) when the tenant's plan does not include the suite. Only enforced when
// ENTITLEMENTS_ENFORCE is on; ignored otherwise (same kill-switch as token gating).
// Usage: @RequiresSuite('manufacturing') on the controller class.
export const RequiresSuite = (suite: SuiteKey) => SetMetadata(REQUIRES_SUITE_KEY, suite);
