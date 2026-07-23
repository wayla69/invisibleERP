import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CampaignStudioService } from '../src/modules/marketing-activation/campaign-studio.service';
import { setLlmClientForTests, type LlmClient } from '../src/common/llm-client';
import { MODEL } from '../src/common/ai-models';
import { featureFlags } from '../src/database/schema';

// Studio v2 (MKT-21) — the LLM copy-refinement layer over the SAME fact sheet + prompt, proven fail-closed:
// a valid schema-conformant answer swaps in the copy + real model id; ANY gate (no key, tenant PDPA
// opt-out) or failure (garbage output, provider error) keeps the deterministic template and reports
// 'studio-template-v1'. Targeting (channel / send-hour / holdout / audience) must stay deterministic on
// BOTH paths. Uses the shared `setLlmClientForTests` seam (docs/27 R4-4) — reset in afterEach.

const OFFER = { item_id: 'CROISSANT', name: 'ครัวซองต์เนยสด', reach: 3, driver_item_id: 'LATTE', driver_name: 'ลาเต้', score: 4.8 };

// Minimal thenable query-builder stub (models the real builder per mantra: every method the service
// chains must exist). featureFlags reads serve aiTenantOptedOut; everything else is the send-hour modal.
function makeDb(flagRows: Array<{ enabled: boolean }> = []) {
  return {
    select: () => ({
      from: (tbl: unknown) => {
        const rows: unknown[] = tbl === featureFlags ? flagRows : [];
        const p: any = {
          where: () => p, groupBy: () => p, orderBy: () => p, limit: () => p,
          then: (onF: any, onR: any) => Promise.resolve(rows).then(onF, onR),
        };
        return p;
      },
    }),
  };
}

function makeService(opts: { flagRows?: Array<{ enabled: boolean }> } = {}) {
  const facts = {
    segmentFacts: async () => ({
      count: 5,
      value: { avg_clv_platform: 100 },
      next_best_action: { dominant: 'WINBACK' },
      best_channel: { channel: 'facebook', roi: 3.2 },
    }),
  };
  const propensity = { topSegmentOffer: async () => OFFER };
  const campaigns = { upsertCampaign: async () => ({ id: 1 }) };
  const crm = { revenueByMembers: async () => new Map<number, number>() }; // A/B outcome read — unused by generate()
  return new CampaignStudioService(makeDb(opts.flagRows) as any, facts as any, campaigns as any, propensity as any, crm as any);
}

function fakeLlm(respond: () => Promise<{ content: Array<{ type: string; text?: string }> }>) {
  const calls: unknown[] = [];
  const client: LlmClient = {
    create: async (params) => { calls.push(params); return respond(); },
    stream: () => { throw new Error('stream unused'); },
  };
  return { calls, client };
}

const user = { tenantId: 7, username: 'napa' } as any;
const VALID_COPY = { subject_th: 'หัวข้อ AI', subject_en: 'AI subject', body_th: 'เนื้อหา AI', body_en: 'AI body' };

describe('CampaignStudioService — studio v2 LLM refinement (fail-closed)', () => {
  const envBackup: Record<string, string | undefined> = {};
  beforeEach(() => {
    envBackup.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
    envBackup.ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL;
    process.env.ANTHROPIC_API_KEY = 'test-key';
    delete process.env.ANTHROPIC_MODEL;
  });
  afterEach(() => {
    setLlmClientForTests(null);
    if (envBackup.ANTHROPIC_API_KEY == null) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = envBackup.ANTHROPIC_API_KEY;
    if (envBackup.ANTHROPIC_MODEL == null) delete process.env.ANTHROPIC_MODEL; else process.env.ANTHROPIC_MODEL = envBackup.ANTHROPIC_MODEL;
  });

  it('valid LLM JSON → copy swapped in, real model id reported, targeting stays deterministic', async () => {
    const { calls, client } = fakeLlm(async () => ({ content: [{ type: 'text', text: JSON.stringify(VALID_COPY) }] }));
    setLlmClientForTests(client);
    const res: any = await makeService().generate(user, 'VIP');
    expect(calls).toHaveLength(1);
    expect(res.model).toBe(MODEL.REASONING);            // the real model id, not the template tag
    expect(res.draft.subject_th).toBe('หัวข้อ AI');
    expect(res.draft.body_en).toBe('AI body');
    // Targeting is NOT the LLM's to change — deterministic from the facts on both paths.
    expect(res.draft.channel).toBe('facebook');
    expect(res.draft.send_hour).toBe(18);               // no preferred-hour rows → clamped default
    expect(res.draft.suggested_holdout_pct).toBe(20);
    expect(res.draft.audience).toBe('mi_segment');
    // The ③→① hook: the segment's top un-bought product is ON the fact sheet and IN the prompt.
    expect(res.facts.top_offer).toBe(OFFER.name);
    expect(res.prompt).toContain(OFFER.name);
  });

  it('an LLM variant_b (docs/62 Phase 3) is adopted as draft_b; without one the deterministic B stands in', async () => {
    const B = { subject_th: 'B หัวข้อ', subject_en: 'B subject', body_th: 'B เนื้อหา', body_en: 'B body' };
    const { client } = fakeLlm(async () => ({ content: [{ type: 'text', text: JSON.stringify({ ...VALID_COPY, variant_b: B }) }] }));
    setLlmClientForTests(client);
    const res: any = await makeService().generate(user, 'VIP');
    expect(res.draft_b).toEqual(B);                      // the LLM's second angle is adopted
    expect(res.draft.subject_th).toBe('หัวข้อ AI');      // and never leaks into variant A
    // Without variant_b in the answer, the deterministic offer-first B fills in (a B always exists).
    const { client: c2 } = fakeLlm(async () => ({ content: [{ type: 'text', text: JSON.stringify(VALID_COPY) }] }));
    setLlmClientForTests(c2);
    const res2: any = await makeService().generate(user, 'VIP');
    expect(typeof res2.draft_b?.body_th).toBe('string');
    expect(res2.draft_b.body_th).not.toBe(res2.draft.body_th);
  });

  it('garbage LLM output → deterministic template + studio-template-v1 (fail-closed)', async () => {
    const { client } = fakeLlm(async () => ({ content: [{ type: 'text', text: 'not json at all' }] }));
    setLlmClientForTests(client);
    const res: any = await makeService().generate(user, 'VIP');
    expect(res.model).toBe('studio-template-v1');
    expect(res.draft.offer_th).toContain(OFFER.name);   // template still weaves the top offer
  });

  it('schema-violating JSON (missing fields) → template (the LLM may only refine the 4 copy fields)', async () => {
    const { client } = fakeLlm(async () => ({ content: [{ type: 'text', text: JSON.stringify({ subject_th: 'x' }) }] }));
    setLlmClientForTests(client);
    const res: any = await makeService().generate(user, 'VIP');
    expect(res.model).toBe('studio-template-v1');
  });

  it('provider error → template (never throws to the caller)', async () => {
    const { client } = fakeLlm(async () => { throw new Error('rate limited'); });
    setLlmClientForTests(client);
    const res: any = await makeService().generate(user, 'VIP');
    expect(res.model).toBe('studio-template-v1');
    expect(typeof res.draft.subject_th).toBe('string');
  });

  it('tenant PDPA opt-out (ai_external_processing=false) → the LLM is NEVER called', async () => {
    const { calls, client } = fakeLlm(async () => ({ content: [{ type: 'text', text: JSON.stringify(VALID_COPY) }] }));
    setLlmClientForTests(client);
    const res: any = await makeService({ flagRows: [{ enabled: false }] }).generate(user, 'VIP');
    expect(calls).toHaveLength(0);
    expect(res.model).toBe('studio-template-v1');
  });

  it('no API key → the LLM is never called and the template answers', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const { calls, client } = fakeLlm(async () => ({ content: [{ type: 'text', text: JSON.stringify(VALID_COPY) }] }));
    setLlmClientForTests(client);
    const res: any = await makeService().generate(user, 'VIP');
    expect(calls).toHaveLength(0);
    expect(res.model).toBe('studio-template-v1');
  });
});
