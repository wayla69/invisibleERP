// Entitlements packaging guard (Wave 1 · workstream 1.1 / 1.8).
// Asserts the plan→suite→module entitlement map in packages/shared is complete and self-consistent:
//   • every coarse MODULE_KEY is assigned to exactly one suite,
//   • no suite lists a sub-permission or unknown token,
//   • every PLAN_SUITES entry references a real suite.
// This is the invariant that lets PlanGuard (1.2) safely gate modules by plan. Run AFTER building shared:
//   pnpm --filter @ierp/shared build && node tools/ci/check-entitlements.mjs
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const distUrl = pathToFileURL(resolve('packages/shared/dist/index.js')).href;

let shared;
try {
  shared = await import(distUrl);
} catch (e) {
  console.error('check-entitlements: could not import @ierp/shared dist — build it first');
  console.error(`  pnpm --filter @ierp/shared build`);
  console.error(String(e?.message ?? e));
  process.exit(1);
}

const { validateEntitlements, SUITES, PLAN_SUITES, KNOWN_UNGATED } = shared;
if (typeof validateEntitlements !== 'function') {
  console.error('check-entitlements: @ierp/shared does not export validateEntitlements — stale dist? rebuild shared.');
  process.exit(1);
}

try {
  const summary = validateEntitlements();
  console.log(`✓ entitlements OK — ${summary.modules} module keys mapped across ${summary.suites} suites, ${summary.plans} plans.`);
  for (const [suite, perms] of Object.entries(SUITES)) {
    console.log(`  · ${suite.padEnd(12)} ${perms.length} module(s): ${perms.join(', ')}`);
  }
  console.log('  plan → suites:');
  for (const [plan, suites] of Object.entries(PLAN_SUITES)) {
    console.log(`  · ${plan.padEnd(12)} ${suites.join(', ')}`);
  }
  if (Array.isArray(KNOWN_UNGATED) && KNOWN_UNGATED.length) {
    console.log(`  ⚠ not yet suite-gatable (needs new tokens, follow-up 1.1b): ${KNOWN_UNGATED.join(', ')}`);
  }
  process.exit(0);
} catch (e) {
  console.error(`✗ entitlements INVALID: ${e?.message ?? e}`);
  process.exit(1);
}
