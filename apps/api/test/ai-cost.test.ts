import { describe, it, expect } from 'vitest';
import { pickModel, SYSTEM_CACHED, TOOLS } from '../src/modules/ai/agent.service';

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

describe('AI cost optimization — prompt caching (cache_control breakpoints)', () => {
  it('caches the system prompt block', () => {
    expect(SYSTEM_CACHED[0]?.cache_control?.type).toBe('ephemeral');
  });
  it('caches the whole tools manifest via cache_control on the LAST tool', () => {
    const lastTool: any = TOOLS[TOOLS.length - 1];
    expect(lastTool?.cache_control?.type).toBe('ephemeral');
  });
});
