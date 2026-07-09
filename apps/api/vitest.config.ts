import { defineConfig } from 'vitest/config';

// ── Coverage-gate sets (single source of truth) ──────────────────────────────
// PURE_MODULES feeds BOTH the coverage `include` and its own glob threshold tier below, so a file added
// here automatically joins the 78/87/77/78 group — the two lists can no longer drift apart (slice-6
// review finding: they used to be maintained by hand in two places).
const PURE_MODULES = [
  // top-level tax core only — documents/ + reports/ moved under tax/ in the docs/28 consolidation
  // and are harness-tested (taxdocs/etax), not unit-tested; add them here WITH tests, not before
  'src/modules/tax/*.ts',
  'src/common/doc-number.service.ts',
  'src/common/ai-models.ts',
  'src/common/pii-redact.ts',
  'src/common/crypto.ts',
  'src/common/money.ts',
  'src/common/ttl-cache.ts', // 2.5 shared-cache adapter — contract-tested in test/cache-adapter.test.ts
  // 2.4 unit-pyramid extension (docs/27 R2-5 unit lane) — pure modules + their suites:
  'src/common/text-similarity.ts',   // test/pure-utils.test.ts
  'src/common/thai-address.ts',      // test/pure-utils.test.ts
  'src/common/bizdate.ts',           // test/pure-utils.test.ts
  'src/common/db-error.ts',          // test/pure-utils.test.ts
  'src/common/net-guard.ts',         // test/net-guard.test.ts (2.4 slice 8 — SSRF guard, security H-1/L-6)
  'src/modules/tax/documents/wht-rates.ts', // test/tax-rules.test.ts (tax-point.ts already in the glob)
  'src/modules/payroll/payroll-calc.ts',    // already tested in test/unit.test.ts — now gated
  'src/modules/payments/promptpay-qr.ts',   // already tested in test/unit.test.ts — now gated
  'src/database/encrypted-column.ts',
  'src/observability/runtime-metrics.ts',
];

// docs/38 sub-services (2.4 slices 4–7): guard paths AND write paths are unit-tested with drizzle-shaped
// fakes — postEntry/approveEntry/reverseEntry/rejectEntry/attemptVoidPosted in test/ledger-posting{,-write}
// .test.ts, recurring/prepaid in test/ledger-recurring.test.ts, PR/PO flows in test/procurement-{pr,po}
// .test.ts, EVM/CPM/health/baselines in test/projects-evm.test.ts. The heaviest read/report paths stay
// harness-tested (basics/compliance/golden). Each file's floor is pinned just below ITS measured coverage —
// a regression on any one file fails the gate even if a sibling improves. NB a per-file floor re-pins to
// the NEW measured value whenever its suite expands: a % can legitimately move down when the executed
// surface grows (projects-evm branches read 92.9% while only 20.5% of statements ran; slice 5 tripled the
// statements and the branch % settled near 80).
const SUB_SERVICE_FLOORS: Record<string, { statements: number; branches: number; functions: number; lines: number }> = {
  'src/modules/ledger/ledger-posting.service.ts':      { statements: 98, branches: 81, functions: 98, lines: 98 }, // 100/83.0/100/100
  'src/modules/ledger/ledger-recurring.service.ts':    { statements: 85, branches: 77, functions: 78, lines: 85 }, // 87.4/79.4/80/87.4
  'src/modules/procurement/procurement-po.service.ts': { statements: 97, branches: 67, functions: 98, lines: 97 }, // 99.3/69.4/100/99.3
  'src/modules/procurement/procurement-pr.service.ts': { statements: 95, branches: 65, functions: 98, lines: 95 }, // 97.8/67.9/100/97.8
  'src/modules/procurement/procurement-grn.service.ts': { statements: 92, branches: 54, functions: 98, lines: 92 }, // 94.6/56.1/100/94.6 — branch % is low because the print/summary mapping is dense with `?? null` fallbacks (each a partial branch); the control gates themselves are fully exercised

  'src/modules/projects/projects-evm.service.ts':      { statements: 90, branches: 75, functions: 85, lines: 90 }, // 92.5/77.2/87.5/92.5
};

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Ratchet coverage gate (operational maturity Tier 2). Scoped to a curated set of pure/critical
    // modules that ARE unit-tested, with thresholds locked just below the measured floor so coverage on
    // these can't regress. EXPAND the sets above + raise the thresholds as more pure logic gets tests —
    // the set grows, the floor ratchets up. (Global coverage is meaningless today: a dozen test files over 600+.)
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: [...PURE_MODULES, ...Object.keys(SUB_SERVICE_FLOORS)],
      exclude: [
        '**/*.module.ts', // Nest module decorators carry no testable logic
        // tax-jobs.service.ts (docs/33 PR4) sits at src/modules/tax/*.ts so the include glob catches it, but
        // it is HARNESS-tested (taxdocs), not unit-tested — same convention as documents/ + reports/. Add it
        // to the coverage set WITH unit tests, not before.
        '**/tax-jobs.service.ts',
      ],
      // Three-tier ratchet (each floor locked just below its measured value; NEVER loosen — a floor may
      // only move down when its measured value itself fell below the old floor because the executed
      // surface grew, per the note above):
      //  1. PURE_MODULES keep their undiluted glob group at the 2026-07-08 floor
      //     (measured stmts 80.3 / branch 89.2 / funcs 79.5 / lines 80.3).
      //  2. SUB_SERVICE_FLOORS pin each docs/38 sub-service per file.
      //  3. The global floor covers the whole expanded set (this vitest version does NOT remove
      //     glob-matched files from the global group) — measured 89.5/78.0/85.2/89.5 after slice 8
      //     (branches moved 80.6→78.0 under the down-repin rule: the grn service joined the set and its
      //     dense `?? null` mapping code grew the branch denominator); it backstops files accidentally
      //     dropped from the globs.
      thresholds: {
        statements: 87, branches: 76, functions: 83, lines: 87,
        [`{${PURE_MODULES.join(',')}}`]: { statements: 78, branches: 87, functions: 77, lines: 78 },
        ...SUB_SERVICE_FLOORS,
      },
    },
  },
  // decorators (@Injectable/@Inject) need experimentalDecorators when esbuild transforms TS
  esbuild: { tsconfigRaw: { compilerOptions: { experimentalDecorators: true, emitDecoratorMetadata: true } } },
});
