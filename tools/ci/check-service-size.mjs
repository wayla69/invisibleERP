// Service-size (god-service accretion) ratchet — docs/46 Phase 0.
// docs/38 decomposed the four god services on 2026-07-08; four days later two facades had regrown
// (bi-generate +68%, ledger +34%) because appending to an existing service was still the cheapest move
// for a new feature. Like the ts-debt and use-client guards, this RATCHETS instead of mandating a
// rewrite: every API module file already over MAX_LOC is grandfathered in the committed baseline
// (service-size-baseline.json) at its current line count and constructor-param count, and those numbers
// may only go DOWN. A PR that grows a grandfathered file, adds a constructor param to one (the
// BiGenerateService 34-optional-deps pattern), or pushes a new file past MAX_LOC fails; the fix is to
// land the addition as its own sub-service / registered provider (docs/46 §4 Phases 1-2, 4d), or — for a
// justified exception — bump the baseline in the same PR with a note, matching the use-client precedent.
// When an extraction shrinks a file, lower the baseline in the same PR (the guard prints the numbers);
// a file that drops below MAX_LOC leaves the baseline entirely.
//
// Regenerate after a conscious change: node tools/ci/check-service-size.mjs --update
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const BASELINE_PATH = 'tools/ci/service-size-baseline.json';
const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
const MAX_LOC = baseline.maxLoc ?? 600;

// Scope: every non-test TS file under the API modules tree — services, but also controllers and the
// single-file `.module.ts` services (customers, crm/accounts…), so logic can't dodge the guard by
// landing in a differently-suffixed file.
const files = [];
const walk = (dir) => {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p);
    else if (f.endsWith('.ts') && !f.endsWith('.spec.ts') && !f.endsWith('.test.ts')) files.push(p);
  }
};
walk('apps/api/src/modules');

// Max constructor-param count across the file's classes. A light scanner (no TS parse): find each
// `constructor(`, walk to its balanced `)`, count top-level commas. Nested (), <>, {}, [] (default
// values, generics, destructured @Inject tokens) are depth-tracked; string/comment interiors skipped.
const ctorParams = (src) => {
  let max = 0;
  const re = /\bconstructor\s*\(/g;
  let m;
  while ((m = re.exec(src))) {
    let depth = 1, commas = 0, sawToken = false;
    for (let i = m.index + m[0].length; i < src.length && depth > 0; i++) {
      const c = src[i];
      if (c === '"' || c === "'" || c === '`') { const q = c; while (++i < src.length && src[i] !== q) if (src[i] === '\\') i++; continue; }
      if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
      if (c === '/' && src[i + 1] === '*') { i += 2; while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++; i++; continue; }
      if ('(<{['.includes(c)) depth++;
      else if (')>}]'.includes(c)) depth--;
      else if (c === ',' && depth === 1) commas++;
      else if (depth >= 1 && /\S/.test(c)) sawToken = true;
    }
    max = Math.max(max, sawToken ? commas + 1 : 0);
  }
  return max;
};

const current = new Map(); // path -> { loc, ctorParams }
for (const f of files) {
  const src = readFileSync(f, 'utf8');
  current.set(f, { loc: src.split('\n').length, ctorParams: ctorParams(src) });
}

if (process.argv.includes('--update')) {
  const next = {};
  for (const [f, v] of [...current.entries()].sort()) if (v.loc > MAX_LOC) next[f] = v;
  writeFileSync(BASELINE_PATH, JSON.stringify({ _note: baseline._note, maxLoc: MAX_LOC, files: next }, null, 2) + '\n');
  console.log(`wrote ${BASELINE_PATH}: ${Object.keys(next).length} grandfathered files over ${MAX_LOC} LOC`);
  process.exit(0);
}

const errors = [];
const shrunk = [];
for (const [f, base] of Object.entries(baseline.files)) {
  const cur = current.get(f);
  if (!cur) { shrunk.push(`${f} no longer exists — remove its baseline entry`); continue; }
  if (cur.loc > base.loc) errors.push(`${f} grew: ${cur.loc} > baseline ${base.loc} LOC`);
  if (cur.ctorParams > base.ctorParams) errors.push(`${f} constructor grew: ${cur.ctorParams} > baseline ${base.ctorParams} params`);
  if (cur.loc < base.loc || cur.ctorParams < base.ctorParams) shrunk.push(`${f} shrank (${cur.loc} LOC / ${cur.ctorParams} params) — ratchet the baseline down`);
}
for (const [f, cur] of current) {
  if (!baseline.files[f] && cur.loc > MAX_LOC) errors.push(`${f} is a NEW file over ${MAX_LOC} LOC (${cur.loc}) — split it before it becomes the next god service`);
}

const over = Object.keys(baseline.files).length;
console.log(`service-size: ${over} grandfathered files over ${MAX_LOC} LOC; ${current.size} files scanned`);
if (errors.length) {
  console.error('❌ service-size ratchet failed (god-service accretion):');
  for (const e of errors) console.error('  - ' + e);
  console.error('   Land the addition as its own sub-service or a registered provider (docs/46 §4:');
  console.error('   BI reports & pending-approval sources register providers; LINE commands register');
  console.error('   handlers) instead of growing the facade. For a justified exception, bump');
  console.error(`   ${BASELINE_PATH} in this PR with a note (use-client precedent).`);
  process.exit(1);
}
if (shrunk.length) {
  console.log('ℹ️ debt went DOWN — ratchet it in this PR (or run --update):');
  for (const s of shrunk) console.log('  - ' + s);
}
console.log('✅ no god-service accretion');
