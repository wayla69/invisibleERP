import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { aiDpaBlocked } from '../../common/ai-models';
import { captureOpsAlert } from '../../observability/instrumentation';

// Pluggable text embedder for RAG (Phase D2). The DEFAULT is a deterministic, dependency-free local
// embedder (hashed bag-of-words → fixed-dim, L2-normalized) so retrieval is testable offline and the
// PGlite harnesses run without an API key or the pgvector extension. In production, set EMBED_PROVIDER
// to a real model (Voyage/OpenAI/Cohere) behind this same interface; cosine similarity + the stored
// number[] embeddings move to a pgvector index unchanged at the call sites.
export const EMBED_DIM = 256;
// Hard cap on tokens processed per embed call — bounds the work on user-controlled input (a huge
// query/document can't drive an unbounded loop). 4000 tokens far exceeds any real chunk/query.
const MAX_TOKENS = 4000;

// Provider result — the caller MUST key retrieval on `provider`: vectors from different embedding spaces
// are not comparable (cosine across spaces is noise), so search filters chunks to the space the query was
// embedded in (docs/27 R4-1).
export interface Embedded { vector: number[]; provider: string }

@Injectable()
export class EmbedderService {
  get provider() { return process.env.EMBED_PROVIDER || 'local'; }

  // Embed one text. SEMANTIC provider (docs/27 R4-1 / AUD-AI-01): EMBED_PROVIDER=voyage calls the Voyage
  // embeddings API (Anthropic's recommended embedding partner; VOYAGE_API_KEY + optional VOYAGE_MODEL,
  // default voyage-3-lite). Fail-safe by design: the AI DPA gate (AIG-05) also covers embedding
  // transmission, and any provider error degrades to the deterministic local embedder with a throttled
  // ops alert — retrieval keeps working on the locally-embedded corpus (provider-filtered), never breaks.
  async embed(text: string): Promise<Embedded> {
    if (this.provider === 'voyage' && !aiDpaBlocked()) {
      try {
        return { vector: await voyageEmbed(text), provider: 'voyage' };
      } catch (e) {
        alertEmbedDegraded(e);
        return { vector: localEmbed(text), provider: 'local' };
      }
    }
    return { vector: localEmbed(text), provider: 'local' };
  }
}

let lastEmbedAlertAt = 0;
function alertEmbedDegraded(err: unknown): void {
  const now = Date.now();
  if (now - lastEmbedAlertAt < 60_000) return;
  lastEmbedAlertAt = now;
  captureOpsAlert('embed_provider_degraded', { provider: 'voyage', degraded: 'falling back to the local lexical embedder — semantic retrieval quality reduced until the provider recovers' }, err);
}

// Voyage embeddings API adapter — plain fetch (no SDK dep), bounded by a 15s timeout. Vector is
// L2-normalized so cosine == dot at the call sites, same contract as the local embedder.
async function voyageEmbed(text: string): Promise<number[]> {
  const key = (process.env.VOYAGE_API_KEY ?? '').trim();
  if (!key) throw new Error('VOYAGE_API_KEY not set');
  const model = (process.env.VOYAGE_MODEL ?? 'voyage-3-lite').trim();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 15_000);
  try {
    const res = await fetch('https://api.voyageai.com/v1/embeddings', {
      method: 'POST', signal: ctl.signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, input: text.slice(0, 16_000) }),
    });
    if (!res.ok) throw new Error(`voyage embeddings HTTP ${res.status}`);
    const json: any = await res.json();
    const v: number[] = json?.data?.[0]?.embedding;
    if (!Array.isArray(v) || !v.length) throw new Error('voyage embeddings: empty vector');
    const norm = Math.sqrt(v.reduce((a, x) => a + x * x, 0)) || 1;
    return v.map((x) => x / norm);
  } finally {
    clearTimeout(timer);
  }
}

// Common English stopwords — dropped so retrieval keys on content words, not filler (otherwise "what
// is the …" inflates cosine on every chunk and breaks cite-or-refuse).
const STOP = new Set('a an and are as at be by for from has have how in into is it its of on or that the their then there these this to was were what when where which who will with within your you we our'.split(' '));
function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9฀-๿]+/gi) ?? []).filter((t) => t.length > 1 && !STOP.has(t));
}

// Hashed bag-of-words: each token (+ adjacent bigram) bumps a bucket; vector is then L2-normalized so
// cosine == dot product. Token overlap → higher cosine; disjoint vocab → ~0 (drives cite-or-refuse).
function localEmbed(text: string): number[] {
  const v = new Array(EMBED_DIM).fill(0);
  // Truncate first, then cap the loop with a constant bound so user-controlled input cannot drive an
  // unbounded loop (CodeQL: loop-bound injection / DoS).
  const toks = tokenize(text).slice(0, MAX_TOKENS);
  const n = Math.min(toks.length, MAX_TOKENS);
  const bump = (s: string, w: number) => {
    const h = parseInt(createHash('sha1').update(s).digest('hex').slice(0, 8), 16);
    v[h % EMBED_DIM] += w;
  };
  for (let i = 0; i < n; i++) {
    bump(toks[i], 1);
    if (i > 0) bump(toks[i - 1] + ' ' + toks[i], 0.5); // bigram for a little phrase sensitivity
  }
  const norm = Math.sqrt(v.reduce((a, x) => a + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

export function cosine(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < n; i++) dot += a[i] * b[i];
  return dot; // inputs are L2-normalized ⇒ dot == cosine
}
