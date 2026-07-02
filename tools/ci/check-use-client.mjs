// 'use client' ratchet (docs/28 §4 / docs/27 R5-2, AUD-ARC-09).
// The web app forfeits App Router server rendering when a file opts into the client bundle. Like the
// ts-debt guard, this RATCHETS instead of mandating a rewrite: the committed baseline (the count of
// files whose first statement is 'use client') may only go DOWN. A new page written client-first when a
// server shell + island split would do fails CI; each RSC conversion lowers the baseline in the same PR.
// Armed after conversions #1 (accounting) + #2 (eam) proved the pattern, per the RFC's own gate.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const baseline = JSON.parse(readFileSync('tools/ci/use-client-baseline.json', 'utf8'));

const files = [];
const walk = (dir) => {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p);
    else if (f.endsWith('.ts') || f.endsWith('.tsx')) files.push(p);
  }
};
walk('apps/web/src');

let useClient = 0;
for (const f of files) {
  // count only a real directive: first non-comment, non-empty line
  const src = readFileSync(f, 'utf8');
  const firstCode = src.split('\n').find((l) => l.trim() && !l.trim().startsWith('//') && !l.trim().startsWith('/*') && !l.trim().startsWith('*'));
  if (firstCode && /^['"]use client['"];?\s*$/.test(firstCode.trim())) useClient++;
}

console.log(`use-client: ${useClient}/${baseline.useClient} files`);
if (useClient > baseline.useClient) {
  console.error(`❌ 'use client' file count rose: ${useClient} > baseline ${baseline.useClient}`);
  console.error('   New pages should be server components with client islands (docs/28 §4; see');
  console.error('   accounting/eam page.tsx + lib/server-api.ts for the pattern). If client-first is');
  console.error('   genuinely required, convert an existing page in the same PR to keep the count flat.');
  process.exit(1);
}
if (useClient < baseline.useClient) {
  console.log(`ℹ️ count went DOWN — ratchet it: set tools/ci/use-client-baseline.json to {"useClient": ${useClient}} in this PR.`);
}
console.log('✅ no new client-first files');
