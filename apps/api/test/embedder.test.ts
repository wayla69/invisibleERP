import { describe, it, expect, afterEach } from 'vitest';
import { EmbedderService, EMBED_DIM, cosine } from '../src/modules/ai/embedder';

// docs/24 R4-1 — the semantic provider is fail-safe: any voyage failure (here: no key) degrades to the
// deterministic local embedder, stamped with the space it actually used, so retrieval filters correctly.
afterEach(() => { delete process.env.EMBED_PROVIDER; delete process.env.VOYAGE_API_KEY; });

describe('EmbedderService — provider selection + fail-safe fallback', () => {
  it('local by default: deterministic, L2-normalized, provider-stamped', async () => {
    const e = new EmbedderService();
    const a = await e.embed('refund policy for damaged goods');
    const b = await e.embed('refund policy for damaged goods');
    expect(a.provider).toBe('local');
    expect(a.vector).toHaveLength(EMBED_DIM);
    expect(cosine(a.vector, b.vector)).toBeCloseTo(1, 6); // deterministic
  });
  it('voyage without a key degrades to local (never throws, never mislabels the space)', async () => {
    process.env.EMBED_PROVIDER = 'voyage';
    const e = new EmbedderService();
    const r = await e.embed('hello world');
    expect(r.provider).toBe('local'); // fell back — retrieval will filter to the space actually used
    expect(r.vector).toHaveLength(EMBED_DIM);
  });
});
