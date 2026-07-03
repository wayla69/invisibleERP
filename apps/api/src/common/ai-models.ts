// Centralized Claude model selection (panel Round-2, condition #4 — cost).
// Previously four services hardcoded `claude-opus-4-8` for mechanical extraction/parsing tasks, paying
// reasoning-tier rates for work Haiku/Sonnet handle. This module names the tiers once and routes each
// task to the cheapest model that fits. The ANTHROPIC_MODEL env pin still overrides everything (parity
// tests / operator escape hatch).

export const MODEL = {
  // Strongest tier — multi-step reasoning / final synthesis where quality matters most.
  REASONING: 'claude-sonnet-4-6',
  // Cheap, fast tier — mechanical relay, structured extraction, NL→query, single-shot transforms.
  CHEAP: 'claude-haiku-4-5-20251001',
} as const;

// Task → default tier. Keep this the single source of truth; add a task key rather than hardcoding a model.
export type AiTask =
  | 'agent_reasoning'   // agent first turn / synthesis
  | 'agent_tool_relay'  // agent tool-result follow-up
  | 'doc_extract'       // doc-ai: pull fields out of pasted invoice text
  | 'nl_query'          // nl-analytics: natural language → query spec
  | 'config_suggest'    // ai-config: describe → propose a Studio config JSON
  | 'insight'           // analytics insights narrative
  | 'chat_copilot';     // LINE chat copilot: Thai free text → structured command DRAFT (confirm-first)

const TASK_MODEL: Record<AiTask, string> = {
  agent_reasoning: MODEL.REASONING,
  agent_tool_relay: MODEL.CHEAP,
  doc_extract: MODEL.CHEAP,   // was Opus — extraction is a structured single-shot task
  nl_query: MODEL.CHEAP,      // was Opus — short NL→query parse
  config_suggest: MODEL.REASONING, // JSON config benefits from stronger structure adherence
  insight: MODEL.REASONING,        // narrative analytics — quality-sensitive
  chat_copilot: MODEL.CHEAP,       // short NL→draft parse; execution is human-confirmed anyway (LP-2)
};

// Resolve the model for a task. `ANTHROPIC_MODEL` (when set) pins everything to one model.
export function modelFor(task: AiTask, envPin = process.env.ANTHROPIC_MODEL): string {
  return envPin && envPin.trim() ? envPin.trim() : TASK_MODEL[task];
}

// Production legal gate (panel Round-2, condition #2). The AI assistant must NOT transmit tenant data to
// Anthropic until the Data Processing Addendum is executed. In production, when an API key is present but
// AI_DPA_ACKNOWLEDGED is unset, AI is BLOCKED (fail-closed): agent endpoints raise AI_DPA_REQUIRED and the
// fallback services degrade to their deterministic (no-transmission) path. Dev/test is unaffected.
export function aiDpaBlocked(): boolean {
  return process.env.NODE_ENV === 'production'
    && !!(process.env.ANTHROPIC_API_KEY || '').trim()
    && !(process.env.AI_DPA_ACKNOWLEDGED || '').trim();
}

// ── Token-budget cap resolution (round-2 AI NEW-2: previously untested inline logic) ────────────────
// Pure: resolves a plan's raw feature values to two FINITE thresholds. Rules (ITGC-SEC-AI-01):
//   • missing plan / missing included cap → conservative finite default (never unlimited)
//   • legacy -1 "unlimited" → the enterprise ceiling (finite)
//   • hard max missing or below the included cap → no overage band (included IS the ceiling)
export function resolveBudgetCaps(
  plan: { included: number | null; hardmax: number | null } | undefined,
  defaults: { includedDefault: number; enterpriseCap: number },
): { included: number; hardMax: number } {
  let included = plan && plan.included != null ? Number(plan.included) : defaults.includedDefault;
  if (included < 0) included = defaults.enterpriseCap;
  let hardMax = plan && plan.hardmax != null ? Number(plan.hardmax) : included;
  if (hardMax < 0) hardMax = defaults.enterpriseCap;
  if (hardMax < included) hardMax = included;
  return { included, hardMax };
}
