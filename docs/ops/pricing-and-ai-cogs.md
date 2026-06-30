# Pricing & AI COGS — tier caps and overage (DRAFT)

> **Status: DRAFT v0.1 (2026-06-30).** All prices and token caps below are **`<<PLACEHOLDER>>`** values
> pending **founder sign-off**. This document exists to make the *mechanism* explicit (finite caps, metered
> overage, AI cost-of-goods visibility) so the numbers can be set deliberately rather than left implicit.
> Code source of truth for the caps: `apps/api/src/modules/billing/billing.service.ts` (`PLAN_SEED`).

## Why this exists (panel Round-2, condition #3)

The platform meters AI tokens per tenant (`ai_token_usage`) but previously priced AI as an unlimited bucket
on the Enterprise tier (`ai_tokens_daily: -1`). On a usage-priced upstream (Anthropic) under a flat
subscription, **one heavy Enterprise tenant could burn more in API spend than their seat costs** — negative
gross margin that worsens as the best customers scale. This change makes **every tier finite** and **meters
overage** so over-limit usage is billed, not given away.

## Tier caps (FINITE — no unlimited tier)

| Plan | Price/mo (THB) | `ai_chat` | `ai_tokens_daily` (included) | Notes |
|------|----------------|-----------|------------------------------|-------|
| Free | `<<0>>` | off | 0 | AI disabled |
| Starter | `<<990>>` | off | 0 | AI disabled |
| Pro | `<<2,900>>` | on | `<<200,000>>` | included daily tokens |
| Enterprise | `<<custom>>` | on | `<<2,000,000>>` | high **finite** ceiling, not unlimited |

- The legacy `-1` ("unlimited") is no longer honored: `checkBudget` maps any negative cap to
  `AI_ENTERPRISE_DAILY_CAP` (env, default **2,000,000**), a finite ceiling.
- A plan that omits `ai_tokens_daily` falls back to a conservative finite default
  (`DEFAULT_AI_DAILY = 50,000`) — never unlimited.

## Overage metering

- Tokens consumed beyond a tenant's included cap are recorded in `ai_token_usage.overage_tokens` (migration
  `0194`). The current turn that crosses the cap is allowed to complete and its over-portion is recorded; the
  next request is blocked with `AI_BUDGET_EXCEEDED` until midnight Bangkok time.
- **`<<Overage rate>>`**: THB per 1,000 overage tokens — **TBD by founder**. Billing integration to invoice
  `overage_tokens` is a follow-on (out of scope here).

## AI cost-of-goods (COGS) note

- Model tiering (`apps/api/src/common/ai-models.ts`) routes mechanical tasks (extraction, NL→query,
  tool-relay) to the **Haiku** tier and reserves **Sonnet** for reasoning/synthesis — no task defaults to
  Opus. This is the primary COGS lever; the eval harness (`tools/cutover/src/ai-eval.ts`) guards against
  regression to Opus.
- Prompt caching (system prompt + tool manifest) further cuts input-token cost per turn.
- **`<<Target gross margin>>`**, **`<<blended COGS per tenant>>`**, **`<<CAC payback>>`** — to be filled by
  Finance for the funding model.

## Revision history

| Date | Version | Change |
|------|---------|--------|
| 2026-06-30 | v0.1 (DRAFT) | Initial — finite tier caps, overage metering, AI-COGS note. Placeholders pending founder sign-off. |
