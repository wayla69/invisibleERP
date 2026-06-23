import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';

// Pluggable text embedder for RAG (Phase D2). The DEFAULT is a deterministic, dependency-free local
// embedder (hashed bag-of-words → fixed-dim, L2-normalized) so retrieval is testable offline and the
// PGlite harnesses run without an API key or the pgvector extension. In production, set EMBED_PROVIDER
// to a real model (Voyage/OpenAI/Cohere) behind this same interface; cosine similarity + the stored
// number[] embeddings move to a pgvector index unchanged at the call sites.
export const EMBED_DIM = 256;

@Injectable()
export class EmbedderService {
  get provider() { return process.env.EMBED_PROVIDER || 'local'; }

  // Returns an L2-normalized vector of length EMBED_DIM. Deterministic for the local provider.
  async embed(text: string): Promise<number[]> {
    // Only 'local' is implemented here; a real provider adapter would call its API and return the vector.
    return localEmbed(text);
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
  const toks = tokenize(text);
  const bump = (s: string, w: number) => {
    const h = parseInt(createHash('sha1').update(s).digest('hex').slice(0, 8), 16);
    v[h % EMBED_DIM] += w;
  };
  for (let i = 0; i < toks.length; i++) {
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
