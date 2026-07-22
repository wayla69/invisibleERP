// Platform-owner ("god") surface ratchet — cross-tenant privilege archetype.
//
// A @PlatformAdmin route is the highest-privilege surface in the system: PlatformAdminGuard sets the
// server-only req.__platformBypass, which TenantTxInterceptor honours as a FULL cross-tenant RLS bypass.
// One such route reads or writes EVERY company's data — GET /api/admin/tenants/:id/export streams every row
// of every tenant-scoped table for a chosen company. Adding one is therefore not like adding ordinary CRUD:
// it widens the blast radius of a single credential across the whole fleet.
//
// That surface grew 26 → 38 routes (+46%) unnoticed, because nothing watched it — every other ratchet
// (ts-debt, use-client, service-size, ledger-boundary, maker-checker) measures something else. This gate
// makes the god surface an EXPLICIT, reviewed inventory instead of an emergent number:
//   • a route NOT in tools/ci/platform-surface-baseline.json fails the build — adding god authority becomes
//     a conscious act with a written justification in the same PR (use-client / maker-checker precedent);
//   • a baseline entry whose route no longer exists fails too, so the inventory can never drift into
//     fiction (the maker-checker "stale exemption" rule — a security inventory is only useful if honest);
//   • @PlatformAdmin + @Public on the same handler fails outright: that combination would expose a
//     cross-tenant route with NO authentication at all, and there is no legitimate reason for it.
//
// The inventory also records which routes are DESTRUCTIVE (purge/delete/factory-reset/force-*) and which
// are reads, purely as review signal — a diff that adds a destructive god route should draw more scrutiny
// than one that adds a list endpoint.
//
// It deliberately does NOT cap the count at a number: the fleet surface legitimately grows with the SaaS
// business (billing, onboarding, lifecycle). What it refuses is growth that nobody reviewed.
//
// Regenerate after a conscious change: node tools/ci/check-platform-surface.mjs --update
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';

const BASELINE_PATH = 'tools/ci/platform-surface-baseline.json';
const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
const allowed = baseline.routes ?? {};

const ROUTE_DECORATOR = /@(Get|Post|Put|Patch|Delete)\(\s*(?:['"`]([^'"`]*)['"`])?/g;
// Fleet-destructive verbs — irreversible or mass-effect operations on data the platform does not own.
// `preview` is excluded: the dry-run half of a destructive pair (…/force-preview) reports a blast radius
// without causing one, and flagging it would put a false claim in an auditable inventory.
const DESTRUCTIVE = /(purge|delete|factory-reset|force-|wipe|reset)/i;
const isDestructive = (path) => DESTRUCTIVE.test(path) && !/preview/i.test(path);

// Normalised to POSIX separators — node:path join() emits '\' on Windows, and a baseline keyed on
// forward-slash paths would then match NOTHING, silently reporting an empty surface (the exact failure
// mode that has bitten tools/ci scripts on this repo before).
const files = [];
const walk = (dir) => {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p);
    else if (f.endsWith('.controller.ts')) files.push(p.split(sep).join('/'));
  }
};
walk('apps/api/src');

// The decorators belonging to ONE handler are the contiguous run of decorator lines around it — this repo
// writes both `@Post('x') @PlatformAdmin() @HttpCode(201)` (one line) and the stacked multi-line form, so
// walk outward from the route-decorator's line while the neighbouring lines are still decorators.
const decoratorBlockAt = (lines, idx) => {
  const isDecorator = (l) => l.trim().startsWith('@');
  let lo = idx;
  while (lo > 0 && isDecorator(lines[lo - 1])) lo--;
  let hi = idx;
  while (hi + 1 < lines.length && isDecorator(lines[hi + 1])) hi++;
  return lines.slice(lo, hi + 1).join('\n');
};

const routes = []; // { route, file, method, destructive, isPublic }
for (const file of files) {
  const src = readFileSync(file, 'utf8');
  const lines = src.split('\n');
  const base = (src.match(/@Controller\(\s*['"`]([^'"`]*)['"`]/)?.[1] ?? '').replace(/\/$/, '');
  // Class-level @PlatformAdmin() applies to every handler (Reflector.getAllAndOverride reads handler THEN class).
  const controllerLine = lines.findIndex((l) => l.includes('@Controller('));
  const classIsPlatform = controllerLine >= 0 && /@PlatformAdmin\s*\(/.test(decoratorBlockAt(lines, controllerLine));

  for (let i = 0; i < lines.length; i++) {
    ROUTE_DECORATOR.lastIndex = 0;
    const m = ROUTE_DECORATOR.exec(lines[i]);
    if (!m) continue;
    if (i === controllerLine) continue; // @Controller line itself
    const block = decoratorBlockAt(lines, i);
    if (!classIsPlatform && !/@PlatformAdmin\s*\(/.test(block)) continue;
    const sub = (m[2] ?? '').replace(/^\//, '');
    const full = '/' + [base, sub].filter(Boolean).join('/');
    routes.push({
      route: `${m[1].toUpperCase()} ${full}`,
      file,
      destructive: isDestructive(full),
      isPublic: /@Public\s*\(/.test(block),
    });
  }
}
routes.sort((a, b) => a.route.localeCompare(b.route));

if (process.argv.includes('--update')) {
  const inventory = {};
  for (const r of routes) {
    inventory[r.route] = {
      file: r.file,
      ...(r.destructive ? { destructive: true } : {}),
      // Preserve a hand-written justification if the entry already had one.
      ...(allowed[r.route]?.reason ? { reason: allowed[r.route].reason } : {}),
    };
  }
  writeFileSync(BASELINE_PATH, JSON.stringify({ _note: baseline._note, routes: inventory }, null, 2) + '\n');
  console.log(`wrote ${BASELINE_PATH}: ${routes.length} platform-owner routes discovered`);
  process.exit(0);
}

const errors = [];
const live = new Set(routes.map((r) => r.route));
for (const r of routes) {
  if (r.isPublic) {
    errors.push(`${r.route} — carries BOTH @PlatformAdmin and @Public: an unauthenticated cross-tenant route. Remove @Public.`);
  }
  if (!(r.route in allowed)) {
    errors.push(`${r.route} (${r.file}) — NEW platform-owner route: it runs with a full cross-tenant RLS bypass and is not in the reviewed inventory`);
  }
}
for (const route of Object.keys(allowed)) {
  if (!live.has(route)) errors.push(`inventory route no longer exists: ${route} — remove it from ${BASELINE_PATH} (the god inventory must stay honest)`);
}

const destructive = routes.filter((r) => r.destructive).length;
const reads = routes.filter((r) => r.route.startsWith('GET ')).length;
console.log(`platform-surface: ${routes.length}/${Object.keys(allowed).length} god routes (${reads} read, ${routes.length - reads} write; ${destructive} destructive)`);
if (errors.length) {
  console.error('❌ platform-owner surface ratchet failed:');
  for (const e of errors) console.error('  - ' + e);
  console.error('   A @PlatformAdmin route grants FLEET-WIDE data access to one credential. Before adding one, ask');
  console.error('   whether it can be a tenant-scoped route with an ordinary @Permissions duty instead (the platform');
  console.error('   console only needs god authority for cross-COMPANY operations, not for reading its own config).');
  console.error(`   If it genuinely must be god-only, run: node ${BASELINE_PATH.replace('platform-surface-baseline.json', 'check-platform-surface.mjs')} --update`);
  console.error('   and add a "reason" to the new entry in the same PR. Removing a route? Drop its entry too.');
  process.exit(1);
}
console.log('✅ platform-owner surface matches the reviewed inventory');
