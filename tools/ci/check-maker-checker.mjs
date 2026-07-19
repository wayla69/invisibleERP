// Maker-checker coverage ratchet — SOX-ICFR audit finding #6 (SoD bypass by omission).
//
// Static SoD (a user may not hold both sides of a rule) is enforced at permission-assignment time and
// ToE-tested. DYNAMIC maker-checker (the SAME item's approver must differ from its maker) is enforced only
// by hand-placed `assertMakerChecker(...)` calls INSIDE service methods — there is no guard/decorator that
// forces it. So a developer who adds a new approve/override/authorize endpoint and simply forgets the call
// ships a self-approval hole, and nothing structural catches it. For SOX that is the gap between a control
// being "designed" and "operating".
//
// This gate closes the omission path. It enumerates every state-mutating route whose path names a
// sensitive maker-checker verb (approve / override / authorize / certify / reverse / release / void /
// dispose / write-off) and requires each to be COVERED — either:
//   • its owning module enforces maker-checker somewhere (`assertMakerChecker` / the workflow
//     `assertActionAllowed` SoD engine) — the module-level presumption that the seam is wired, OR
//   • it is listed in the exemption baseline with an explicit human-written reason (an approval surface
//     that is genuinely not a self-approval risk — e.g. an admin-only config toggle, or a pure rejection).
// A NEW sensitive route in a module with NO maker-checker enforcement, and not exempted, FAILS the build —
// forcing the author to add the check or justify the exemption in the same PR (use-client precedent).
//
// It intentionally does NOT try to prove each individual route reaches the check (cross-file taint is
// fragile); the module-level presumption + the explicit exemption list are the auditable control surface.
//
// Regenerate the discovered inventory after a conscious change: node tools/ci/check-maker-checker.mjs --update
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const BASELINE_PATH = 'tools/ci/maker-checker-baseline.json';
const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
const exempt = baseline.exempt ?? {};

// Sensitive maker-checker verbs, matched against the ROUTE PATH (not the method name — the URL is the
// stable contract). `authoriz`/`certif` catch -e/-ation variants.
const SENSITIVE = /(approve|override|authoriz|certif|reverse|release|dispose|write-?off|self-approv)/i;
// Only state-mutating verbs carry the risk; a GET can't self-approve.
const MUTATING = new Set(['Post', 'Put', 'Patch', 'Delete']);

const files = [];
const walk = (dir) => {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p);
    else if (f.endsWith('.controller.ts')) files.push(p);
  }
};
walk('apps/api/src');

// module key = the path segment under apps/api/src/modules/<module> (or the dir under src/ otherwise), used
// both to group and to look up whether that module enforces maker-checker anywhere.
const moduleOf = (file) => {
  const m = file.match(/apps\/api\/src\/modules\/([^/]+)/);
  if (m) return `modules/${m[1]}`;
  const m2 = file.match(/apps\/api\/src\/([^/]+)/);
  return m2 ? m2[1] : 'src';
};

// Does any .ts under this module reference a maker-checker enforcement primitive?
const enforceCache = new Map();
const moduleEnforces = (moduleKey) => {
  if (enforceCache.has(moduleKey)) return enforceCache.get(moduleKey);
  const dir = join('apps/api/src', moduleKey);
  let found = false;
  const scan = (d) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) { scan(p); if (found) return; }
      else if (f.endsWith('.ts')) {
        const src = readFileSync(p, 'utf8');
        if (src.includes('assertMakerChecker') || src.includes('assertActionAllowed')) { found = true; return; }
      }
    }
  };
  try { scan(dir); } catch { /* module dir may not exist for non-module controllers */ }
  enforceCache.set(moduleKey, found);
  return found;
};

// Extract routes: capture the @Controller('base') prefix, then each mutating method decorator + its path.
const routes = []; // { route, file, module }
for (const file of files) {
  const src = readFileSync(file, 'utf8');
  const base = (src.match(/@Controller\(\s*['"`]([^'"`]*)['"`]/)?.[1] ?? '').replace(/\/$/, '');
  const re = /@(Post|Put|Patch|Delete)\(\s*(?:['"`]([^'"`]*)['"`])?/g;
  let m;
  while ((m = re.exec(src))) {
    const method = m[1];
    if (!MUTATING.has(method)) continue;
    const sub = (m[2] ?? '').replace(/^\//, '');
    const full = '/' + [base, sub].filter(Boolean).join('/');
    if (!SENSITIVE.test(full)) continue;
    routes.push({ route: `${method.toUpperCase()} ${full}`, file, module: moduleOf(file) });
  }
}
routes.sort((a, b) => a.route.localeCompare(b.route));

if (process.argv.includes('--update')) {
  // Emit the full discovered inventory with the auto-derived coverage, preserving existing exemptions.
  const inventory = {};
  for (const r of routes) inventory[r.route] = { module: r.module, moduleEnforces: moduleEnforces(r.module) };
  writeFileSync(BASELINE_PATH, JSON.stringify({ _note: baseline._note, exempt, inventory }, null, 2) + '\n');
  console.log(`wrote ${BASELINE_PATH}: ${routes.length} sensitive routes discovered`);
  process.exit(0);
}

const errors = [];
for (const r of routes) {
  if (moduleEnforces(r.module)) continue;       // module wires the maker-checker seam
  const ex = exempt[r.route];
  if (ex && typeof ex.reason === 'string' && ex.reason.trim()) continue; // justified exemption
  if (ex) { errors.push(`${r.route} — exemption present but missing a "reason"`); continue; }
  errors.push(`${r.route} (${r.module}) — sensitive maker-checker route, but its module has no assertMakerChecker/assertActionAllowed and it is not exempted`);
}
// Stale exemptions (route renamed/removed) must be cleaned up so the list stays honest.
const live = new Set(routes.map((r) => r.route));
for (const route of Object.keys(exempt)) if (!live.has(route)) errors.push(`exempt route no longer exists: ${route} — remove it from ${BASELINE_PATH}`);

const enforced = routes.filter((r) => moduleEnforces(r.module)).length;
console.log(`maker-checker: ${routes.length} sensitive routes; ${enforced} module-enforced; ${Object.keys(exempt).length} exempted`);
if (errors.length) {
  console.error('❌ maker-checker coverage ratchet failed:');
  for (const e of errors) console.error('  - ' + e);
  console.error('   Add assertMakerChecker(...) to the approving service (common/control-profile.ts), or —');
  console.error(`   if the route is genuinely not a self-approval risk — add it to ${BASELINE_PATH} "exempt" with a reason.`);
  process.exit(1);
}
console.log('✅ every sensitive maker-checker route is covered');
