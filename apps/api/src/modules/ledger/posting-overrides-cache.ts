// Per-tenant posting-override cache (docs/43 PR-1). One module-scoped TtlCache shared by the READ side
// (LedgerService.postingOverrides — hot POS/posting paths take ≤1 short-TTL cached lookup per event) and
// the WRITE side (PostingService approve/reject/deactivate bust the tenant's prefix so a just-approved
// rule applies on the next posting, not a TTL later). Keys MUST carry the tenant id (ttl-cache contract).
// The 5s TTL mirrors ModuleConfigService's guard cache — bust-on-write is the primary freshness mechanism,
// the TTL is the backstop.
import { TtlCache } from '../../common/ttl-cache';

export const POSTING_OVERRIDES_TTL_MS = 5_000;

export const postingOverridesCache = new TtlCache(2000);

export const postingOverridesKey = (tenantId: number, eventType: string) => `povr:${tenantId}:${eventType}`;

export function bustPostingOverridesCache(tenantId: number | null | undefined): void {
  if (tenantId == null) return;
  postingOverridesCache.deletePrefix(`povr:${tenantId}:`);
}
