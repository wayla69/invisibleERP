// LLM provider seam (docs/24 R4-4 / AUD-AI-04).
// Six services each lazy-required the Anthropic SDK and built their own client — a hard single-provider
// dependency with no way to substitute anything (second provider later, or a deterministic fake for
// scored evals). This module is the ONE construction point:
//   - Production: wraps the Anthropic Messages API exactly as before (lazy require, maxRetries: 3 for
//     jittered 429/5xx backoff). No behavioral change.
//   - Tests/evals: `setLlmClientForTests(fake)` swaps every service onto a scripted client, so the agent
//     loop / extraction / NL-parse paths can be driven END-TO-END in CI without an API key — the basis of
//     the scored eval benchmark in tools/cutover/src/ai-eval.ts.
// This is deliberately a SEAM, not a second provider: the params/response shapes remain the Anthropic
// Messages API. A future provider adapter maps into this contract here, in one file.

export interface LlmClient {
  /** Anthropic messages.create passthrough — (params, options?) → response promise. */
  create(params: any, options?: any): Promise<any>;
  /** Anthropic messages.stream passthrough — (params, options?) → MessageStream. */
  stream(params: any, options?: any): any;
}

let testOverride: LlmClient | null = null;

/** Test/eval hook: force every service onto a scripted client (null restores the real provider). */
export function setLlmClientForTests(client: LlmClient | null): void {
  testOverride = client;
}

/** Build (or return the injected) LLM client. Call per use — construction is cheap and the override
 *  must be honored even for services that cached their apiKey at boot. */
export function llmClient(apiKey: string): LlmClient {
  if (testOverride) return testOverride;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Anthropic = require('@anthropic-ai/sdk').default ?? require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey, maxRetries: 3 }); // jittered backoff for 429/5xx
  return {
    create: (params, options) => client.messages.create(params, options),
    stream: (params, options) => client.messages.stream(params, options),
  };
}
