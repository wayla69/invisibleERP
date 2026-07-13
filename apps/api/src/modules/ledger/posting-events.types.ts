// docs/46 Phase 5 — shared types + the `r` leg helper for the per-domain posting-event definition
// files (split out of posting-events.ts; the composed registry + its API live there unchanged).
export type PostingSide = 'DR' | 'CR';
export type RoleTier = 'free' | 'widen' | 'pinned';

export interface PostingRoleDef {
  side: PostingSide;
  /** The real literal the posting site falls back to (kept in lock-step by importing THIS constant). */
  default: string;
  tier: RoleTier;
  description: string;
}

export interface PostingEventDef {
  name: string;
  description: string;
  /** Delivered = a real posting path consumes overrides for this event today; catalog = visibility/roadmap. */
  wired: boolean;
  roles: Record<string, PostingRoleDef>;
}

export const DR = 'DR' as const, CR = 'CR' as const;
export const r = (side: PostingSide, def: string, tier: RoleTier, description: string): PostingRoleDef => ({ side, default: def, tier, description });
