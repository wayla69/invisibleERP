// TypeScript-debt ratchet (docs/27 R2-5 / AUD-ARC-05).
// The API weakened two safety nets: `noUncheckedIndexedAccess` is disabled in apps/api/tsconfig.json
// (248 errors when enabled, as of 2026-07-02) and `as any` is pervasive (1,456 occurrences). Fixing all of
// it in one PR is regression-roulette on money paths — so this guard RATCHETS instead: the committed
// baseline (ts-debt-baseline.json) may only go DOWN. Any PR that ADDS an `as any` or a new strict-index
// error fails; when you reduce debt, lower the baseline in the same PR (the guard tells you the numbers).
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

const baseline = JSON.parse(readFileSync('tools/ci/ts-debt-baseline.json', 'utf8'));

// ── 1. `as any` count across the API source ──
const files = [];
const walk = (dir) => {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p);
    else if (f.endsWith('.ts')) files.push(p);
  }
};
walk('apps/api/src');
let asAny = 0;
const perFile = new Map();
for (const f of files) {
  const n = (readFileSync(f, 'utf8').match(/\bas any\b/g) ?? []).length;
  if (n) { asAny += n; perFile.set(f, n); }
}

// ── 2. strict-index error count (CLI flag overrides the tsconfig's `false`) ──
let strictErrors = 0;
try {
  execSync('pnpm exec tsc --noEmit --noUncheckedIndexedAccess', { cwd: 'apps/api', stdio: 'pipe' });
} catch (e) {
  strictErrors = (String(e.stdout ?? '').match(/error TS/g) ?? []).length;
  if (!strictErrors) throw e; // tsc failed for a non-diagnostic reason — surface it
}

const errors = [];
if (asAny > baseline.asAny) errors.push(`\`as any\` count rose: ${asAny} > baseline ${baseline.asAny}`);
if (strictErrors > baseline.strictIndexErrors) errors.push(`noUncheckedIndexedAccess errors rose: ${strictErrors} > baseline ${baseline.strictIndexErrors}`);

console.log(`ts-debt: as-any ${asAny}/${baseline.asAny} · strict-index errors ${strictErrors}/${baseline.strictIndexErrors}`);
if (errors.length) {
  console.error('❌ TypeScript-debt ratchet failed (new debt added):');
  for (const e of errors) console.error('  - ' + e);
  const top = [...perFile.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  console.error('  top as-any offenders:', top.map(([f, n]) => `${f}:${n}`).join(', '));
  process.exit(1);
}
if (asAny < baseline.asAny || strictErrors < baseline.strictIndexErrors) {
  console.log(`ℹ️ debt went DOWN — ratchet it: set tools/ci/ts-debt-baseline.json to {"asAny": ${asAny}, "strictIndexErrors": ${strictErrors}} in this PR.`);
}
console.log('✅ no new TypeScript debt');
