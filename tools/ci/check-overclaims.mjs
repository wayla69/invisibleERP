// Compliance overclaim guard (3.6 / IPO honesty).
// CONTROL_STATUS_HONEST.md retracted the "audit-ready" overclaim: "audit-ready" implies controls are
// designed, operating, evidenced over time, and externally testable TODAY — which is not yet true (earliest
// defensible management ICFR assertion is Q1 2027, no external attestation exists). An auditor's first PBC
// reconciliation fails if marketing/compliance docs quietly re-assert what the honest baseline retracts.
//
// This guard fails CI when a bare overclaim phrase appears in compliance/**.md or docs/**.md WITHOUT a
// qualifier that makes it honest (a negation, the careful "≥1 quarter of operating evidence" definition, a
// retraction/target framing) — or in the honest baseline itself, which discusses the retraction.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const BANNED = [
  /\baudit[-\s]?ready\b/i,
  /\bnasdaq[-\s]?ready\b/i,
  /\bipo[-\s]?ready\b/i,
  /\bSOC\s?2\s+certified\b/i,
  /\bISO\s?27001\s+certified\b/i,
  /\b100%\s+compliant\b/i,
  /\bfully\s+compliant\b/i,
  /\bfully\s+SOX[-\s]?compliant\b/i,
];
// A line is honest (allowed) if it negates/qualifies the claim or frames it as a target/definition.
const QUALIFIER = /(not\b|isn'?t\b|never\b|no longer\b|retract|overclaim|stop saying|≥\s?1\s*quarter|operating evidence|definition of|target|earliest|Q[1-4]\s?20\d\d|readiness|roadmap|when\b|once\b|before\b|until\b|would\b|means:)/i;
// The honest baseline file exists to DISCUSS the retraction — exempt it wholesale.
const EXEMPT_FILE = /CONTROL_STATUS_HONEST\.md$/;

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p));
    else if (p.endsWith('.md')) out.push(p);
  }
  return out;
}

const files = [...walk('compliance'), ...walk('docs')];
const violations = [];
for (const f of files) {
  if (EXEMPT_FILE.test(f)) continue;
  const lines = readFileSync(f, 'utf8').split('\n');
  lines.forEach((line, i) => {
    for (const rx of BANNED) {
      if (rx.test(line) && !QUALIFIER.test(line)) {
        violations.push({ file: f, line: i + 1, text: line.trim().slice(0, 140), phrase: rx.source });
        break;
      }
    }
  });
}

if (violations.length) {
  console.error(`✗ compliance overclaim(s) found — these contradict CONTROL_STATUS_HONEST.md's retraction.`);
  console.error(`  Reframe as design-vs-operating / a dated target, or negate. See compliance/CONTROL_STATUS_HONEST.md.\n`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.text}`);
  process.exit(1);
}
console.log(`✓ no compliance overclaims — scanned ${files.length} markdown files (banned phrases require an honest qualifier).`);
process.exit(0);
