#!/usr/bin/env node
/**
 * License-compliance gate for production dependencies.
 *
 * Fails CI if any PRODUCTION dependency carries a strong-copyleft / network-copyleft / non-commercial
 * license that is incompatible with a proprietary SaaS (GPL, AGPL, SSPL, CC-*-NC, EUPL, OSL, …). Weak
 * copyleft (LGPL/MPL) and "Unknown"-metadata packages are reported as WARNINGS (acceptable for a hosted,
 * non-distributed service, but surfaced so they can't accrue silently).
 *
 * SPDX expressions are evaluated correctly:
 *   - "(MIT OR GPL-3.0-or-later)"  → OK   (an OR with a permissive option is satisfiable as permissive)
 *   - "Apache-2.0 AND LGPL-3.0"    → WARN (an AND term applies; LGPL is weak copyleft)
 *   - "AGPL-3.0-only"              → FAIL
 *
 * Uses `pnpm licenses list` (built-in) — no extra dependency. Run from the repo root after install.
 */
import { execSync } from 'node:child_process';

// Explicit allow-list for reviewed exceptions: "<name>@<license>" or "<name>".
const ALLOW = new Set([
  // (none yet — add reviewed exceptions here with a comment + date)
]);

// A single SPDX term is forbidden if it is strong/network copyleft or non-commercial. LGPL is excluded
// here (handled as a warning) since it is weak copyleft and we do not distribute binaries.
function isForbiddenTerm(term) {
  const t = term.replace(/[()]/g, '').trim();
  if (!t) return false;
  if (/LGPL/i.test(t)) return false; // weak copyleft → warning, not failure
  return /\bA?GPL\b|\bA?GPL-|SSPL|CC-BY-NC|CC-BY-NC-|EUPL|\bOSL-|\bRPL-|\bCPAL|\bWTFPL.*NC/i.test(t);
}

// An SPDX expression is acceptable if at least one OR-alternative has no forbidden AND-term.
function acceptable(expr) {
  return expr.split(/\s+OR\s+/i).some((alt) =>
    alt.split(/\s+AND\s+/i).every((term) => !isForbiddenTerm(term)),
  );
}

const raw = execSync('pnpm licenses list --prod --json', { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const data = JSON.parse(raw);

const violations = [];
const warnings = [];
for (const [license, pkgs] of Object.entries(data)) {
  const list = Array.isArray(pkgs) ? pkgs : [];
  for (const p of list) {
    const id = `${p.name}@${p.version ?? (p.versions || []).join('/')}`;
    if (ALLOW.has(id) || ALLOW.has(p.name)) continue;
    if (!acceptable(license)) violations.push(`${id} :: ${license}`);
    else if (/LGPL|MPL/i.test(license)) warnings.push(`${id} :: ${license} (weak copyleft — OK for hosted SaaS)`);
    else if (/unknown|unlicensed/i.test(license)) warnings.push(`${id} :: ${license} (no license metadata — review)`);
  }
}

if (warnings.length) {
  console.warn(`⚠️  License warnings (${warnings.length}):`);
  for (const w of warnings) console.warn('   - ' + w);
}
if (violations.length) {
  console.error(`\n❌ Forbidden licenses in production dependencies (${violations.length}):`);
  for (const v of violations) console.error('   - ' + v);
  console.error('\nThese strong-copyleft / network-copyleft / non-commercial licenses are incompatible with a');
  console.error('proprietary SaaS. Remove the dependency, replace it, or (if genuinely safe) add a reviewed');
  console.error('exception to ALLOW in tools/ci/check-licenses.mjs with a justification.');
  process.exit(1);
}
console.log('✅ License check passed — no GPL/AGPL/SSPL/non-commercial licenses in production dependencies.');
