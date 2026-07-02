// RCM census guard (docs/27 R3-1 / AUD-CMP-01).
// The 2026-07 investment audit found FIVE different control populations quoted across the compliance docs
// (66, 57, 68, 153, 154) vs the real 169 in build_rcm.py — failing an auditor's first PBC reconciliation.
// Rule: any doc that cites the RCM population MUST tag the number machine-readably, e.g.
//   <!-- rcm-total -->169<!-- /rcm-total -->   (also: rcm-implemented / rcm-partial / rcm-gap)
// This guard re-derives the census from compliance/build_rcm.py (the source of truth; same numbers as
// `python3 compliance/build_rcm.py --counts`) and fails CI when ANY tagged claim drifts.
// Untagged historical snapshots (e.g. PRE_PRODUCTION_AUDIT_2026Q2.md) are allowed but must be banner-marked
// as history — new current-state claims must use the tags.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const py = readFileSync('compliance/build_rcm.py', 'utf8');

// total = add(...) control definitions; status = the last argument of each add() call.
const total = (py.match(/^add\(/gm) ?? []).length;
const statuses = { Implemented: 0, Partial: 0, Gap: 0, Planned: 0 };
for (const m of py.matchAll(/,"(Implemented|Partial|Gap|Planned)"\)\s*$/gm)) statuses[m[1]]++;
const statusSum = Object.values(statuses).reduce((a, b) => a + b, 0);
if (!total || statusSum !== total) {
  console.error(`RCM census parse failure: ${total} add() calls but ${statusSum} parsed statuses — fix the guard's regexes or build_rcm.py formatting.`);
  process.exit(1);
}
const census = { total, implemented: statuses.Implemented, partial: statuses.Partial, gap: statuses.Gap };
console.log('census from build_rcm.py:', JSON.stringify(census));

const mdFiles = [];
const walk = (dir) => {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p);
    else if (f.endsWith('.md')) mdFiles.push(p);
  }
};
walk('compliance');
walk('docs');

const TAG = /<!--\s*rcm-(total|implemented|partial|gap)\s*-->\s*(\d+)\s*<!--\s*\/rcm-\1\s*-->/g;
let claims = 0;
const errors = [];
for (const file of mdFiles) {
  const text = readFileSync(file, 'utf8');
  for (const m of text.matchAll(TAG)) {
    claims++;
    const [, kind, valueStr] = m;
    const value = Number(valueStr);
    if (value !== census[kind]) errors.push(`${file}: <rcm-${kind}> claims ${value}, build_rcm.py says ${census[kind]}`);
  }
}

if (!claims) {
  console.error('No tagged RCM census claims found in compliance/ or docs/ — the tags were removed; restore them (see CONTROL_STATUS_HONEST.md §2).');
  process.exit(1);
}
if (errors.length) {
  console.error(`❌ RCM census drift (${errors.length}):`);
  for (const e of errors) console.error('  - ' + e);
  console.error('Regenerate/update the tagged docs to match `python3 compliance/build_rcm.py --counts`.');
  process.exit(1);
}
console.log(`✅ RCM census reconciles — ${claims} tagged claim(s) across ${mdFiles.length} markdown files all match ${total} controls (${census.implemented}/${census.partial}/${census.gap}).`);
