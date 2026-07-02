import { describe, it, expect, afterEach } from 'vitest';
import { pickModel, SYSTEM_CACHED, TOOLS } from '../src/modules/ai/agent.service';
import { modelFor, aiDpaBlocked, MODEL, resolveBudgetCaps } from '../src/common/ai-models';

// Regression guards for the two AI cost optimizations (both already implemented in AgentService): model
// tiering and prompt caching. These exist to stop a future edit silently removing them.
describe('AI cost optimization — model tiering (pickModel)', () => {
  it('uses the cheap model for tool-result follow-up turns (mechanical relay)', () => {
    const msgs = [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: '{}' }] }];
    expect(pickModel(msgs)).toMatch(/haiku/);
  });
  it('uses the stronger model for the initial reasoning turn', () => {
    expect(pickModel([{ role: 'user', content: 'สรุปยอดขายเดือนนี้' }])).toBe('claude-sonnet-4-6');
  });
  it('honours an explicit ANTHROPIC_MODEL pin (parity tests / overrides)', () => {
    const msgs = [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: '{}' }] }];
    expect(pickModel(msgs, 'claude-opus-4-8')).toBe('claude-opus-4-8');
  });
});

describe('AI cost optimization — centralized model tiering (modelFor)', () => {
  it('routes extraction/parse tasks to the CHEAP tier (was Opus)', () => {
    expect(modelFor('doc_extract')).toBe(MODEL.CHEAP);
    expect(modelFor('nl_query')).toBe(MODEL.CHEAP);
    expect(modelFor('agent_tool_relay')).toBe(MODEL.CHEAP);
  });
  it('routes quality-sensitive tasks to the REASONING tier', () => {
    expect(modelFor('agent_reasoning')).toBe(MODEL.REASONING);
    expect(modelFor('config_suggest')).toBe(MODEL.REASONING);
    expect(modelFor('insight')).toBe(MODEL.REASONING);
  });
  it('never defaults to Opus for any task (cost regression guard)', () => {
    for (const t of ['agent_reasoning','agent_tool_relay','doc_extract','nl_query','config_suggest','insight'] as const)
      expect(modelFor(t)).not.toMatch(/opus/);
  });
  it('honours the ANTHROPIC_MODEL pin', () => {
    expect(modelFor('doc_extract', 'claude-opus-4-8')).toBe('claude-opus-4-8');
  });
});

describe('AI legal gate — aiDpaBlocked (panel #2)', () => {
  const saved = { ...process.env };
  afterEach(() => { process.env.NODE_ENV = saved.NODE_ENV; process.env.ANTHROPIC_API_KEY = saved.ANTHROPIC_API_KEY; process.env.AI_DPA_ACKNOWLEDGED = saved.AI_DPA_ACKNOWLEDGED; });
  it('blocks in prod when a key is set but the DPA is not acknowledged', () => {
    process.env.NODE_ENV = 'production'; process.env.ANTHROPIC_API_KEY = 'sk-x'; delete process.env.AI_DPA_ACKNOWLEDGED;
    expect(aiDpaBlocked()).toBe(true);
  });
  it('allows in prod once the DPA is acknowledged', () => {
    process.env.NODE_ENV = 'production'; process.env.ANTHROPIC_API_KEY = 'sk-x'; process.env.AI_DPA_ACKNOWLEDGED = '1';
    expect(aiDpaBlocked()).toBe(false);
  });
  it('never blocks outside production', () => {
    process.env.NODE_ENV = 'test'; process.env.ANTHROPIC_API_KEY = 'sk-x'; delete process.env.AI_DPA_ACKNOWLEDGED;
    expect(aiDpaBlocked()).toBe(false);
  });
});

describe('AI cost optimization — prompt caching (cache_control breakpoints)', () => {
  it('caches the system prompt block', () => {
    expect(SYSTEM_CACHED[0]?.cache_control?.type).toBe('ephemeral');
  });
  it('caches the whole tools manifest via cache_control on the LAST tool', () => {
    const lastTool: any = TOOLS[TOOLS.length - 1];
    expect(lastTool?.cache_control?.type).toBe('ephemeral');
  });
});

describe('resolveBudgetCaps (ITGC-SEC-AI-01 — no unlimited tier)', () => {
  const D = { includedDefault: 50_000, enterpriseCap: 2_000_000 };
  it('missing plan → conservative finite default, no overage band', () => {
    expect(resolveBudgetCaps(undefined, D)).toEqual({ included: 50_000, hardMax: 50_000 });
  });
  it('legacy -1 "unlimited" becomes the finite enterprise ceiling', () => {
    expect(resolveBudgetCaps({ included: -1, hardmax: null }, D)).toEqual({ included: 2_000_000, hardMax: 2_000_000 });
  });
  it('hard max below the included cap clamps up (no inverted band)', () => {
    expect(resolveBudgetCaps({ included: 100_000, hardmax: 60_000 }, D)).toEqual({ included: 100_000, hardMax: 100_000 });
  });
  it('normal plan: included < hardMax defines the metered overage band', () => {
    expect(resolveBudgetCaps({ included: 100_000, hardmax: 300_000 }, D)).toEqual({ included: 100_000, hardMax: 300_000 });
  });
  it('-1 hard max also becomes the enterprise ceiling', () => {
    expect(resolveBudgetCaps({ included: 100_000, hardmax: -1 }, D)).toEqual({ included: 100_000, hardMax: 2_000_000 });
  });
});
