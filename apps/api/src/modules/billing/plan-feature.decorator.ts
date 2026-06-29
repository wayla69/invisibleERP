import { SetMetadata } from '@nestjs/common';

// Metadata key used by PlanGuard to read the required plan feature from route metadata.
export const PLAN_FEATURE_KEY = 'planFeature';

// Decorator: gate a controller class or route handler behind a subscription plan feature flag.
// Feature keys mirror the JSONB keys in plans.features (e.g. 'ai_chat', 'reports').
// Usage: @RequiresPlanFeature('ai_chat') on a controller class or individual handler.
export const RequiresPlanFeature = (feature: string) => SetMetadata(PLAN_FEATURE_KEY, feature);
