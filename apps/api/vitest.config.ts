import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Ratchet coverage gate (operational maturity Tier 2). Scoped to a curated set of pure/critical
    // modules that ARE unit-tested, with thresholds locked just below the measured floor so coverage on
    // these can't regress. EXPAND this list + raise the thresholds as more pure logic gets tests — the set
    // grows, the floor ratchets up. (Global coverage is meaningless today: 6-odd test files over 600+.)
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: [
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
        'src/modules/tax/documents/wht-rates.ts', // test/tax-rules.test.ts (tax-point.ts already in the glob)
        'src/modules/payroll/payroll-calc.ts',    // already tested in test/unit.test.ts — now gated
        'src/modules/payments/promptpay-qr.ts',   // already tested in test/unit.test.ts — now gated

        // docs/38 sub-services (2.4 slice 4): guard paths AND write paths are now unit-tested with
        // drizzle-shaped fakes — postEntry/approveEntry/reverseEntry in test/ledger-posting{,-write}.test.ts,
        // recurring/prepaid in test/ledger-recurring.test.ts, PR/PO flows in test/procurement-{pr,po}.test.ts,
        // EVM math in test/projects-evm.test.ts. The heavy read/report paths stay harness-tested
        // (basics/compliance/golden), which is why the per-file floor sits below the pure modules above.
        'src/modules/ledger/ledger-posting.service.ts',
        'src/modules/ledger/ledger-recurring.service.ts',
        'src/modules/procurement/procurement-po.service.ts',
        'src/modules/procurement/procurement-pr.service.ts',
        'src/modules/projects/projects-evm.service.ts',
        'src/database/encrypted-column.ts',
        'src/observability/runtime-metrics.ts',
      ],
      exclude: [
        '**/*.module.ts', // Nest module decorators carry no testable logic
        // tax-jobs.service.ts (docs/33 PR4) sits at src/modules/tax/*.ts so the include glob catches it, but
        // it is HARNESS-tested (taxdocs), not unit-tested — same convention as documents/ + reports/. Add it
        // to the coverage set WITH unit tests, not before.
        '**/tax-jobs.service.ts',
      ],
      // Three-tier ratchet (each floor locked just below its measured value; NEVER loosen, ratchet UP):
      //  1. The legacy pure-module set keeps its own undiluted glob group at the 2026-07-08 floor
      //     (measured stmts 80.3 / branch 89.2 / funcs 79.5 / lines 80.3). NB when a new file joins the
      //     include list above (other than a docs/38 sub-service), add it to this brace-glob too.
      //  2. The docs/38 sub-services get PER-FILE floors: guard + write paths are unit-tested (2.4
      //     slices 4–5) but the heaviest read/report paths stay harness-tested (basics/compliance/
      //     golden), so each file's floor is pinned just below ITS measured coverage (2026-07-09) —
      //     a regression on any one file fails the gate even if a sibling improves. NB a per-file
      //     floor re-pins to the NEW measured value whenever its suite expands: a % can legitimately
      //     move down when the executed surface grows (projects-evm branches read 92.9% while only
      //     20.5% of statements ran; slice 5 tripled the statements and the branch % settled at 79.7).
      //  3. The global floor covers the whole expanded set (this vitest version does NOT remove
      //     glob-matched files from the global group) — measured 70.0/82.3/73.8/70.0 after slice 5;
      //     it backstops files accidentally dropped from the globs.
      thresholds: {
        statements: 68, branches: 80, functions: 71, lines: 68,
        '{src/common/*.ts,src/modules/tax/**/*.ts,src/modules/payroll/payroll-calc.ts,src/modules/payments/promptpay-qr.ts,src/database/encrypted-column.ts,src/observability/runtime-metrics.ts}':
          { statements: 78, branches: 87, functions: 77, lines: 78 },
        'src/modules/ledger/ledger-posting.service.ts':      { statements: 77, branches: 83, functions: 48, lines: 77 }, // 79.5/85.8/50/79.5
        'src/modules/ledger/ledger-recurring.service.ts':    { statements: 85, branches: 77, functions: 78, lines: 85 }, // 87.4/79.4/80/87.4
        'src/modules/procurement/procurement-po.service.ts': { statements: 32, branches: 21, functions: 64, lines: 32 }, // 34.1/23.1/66.7/34.1
        'src/modules/procurement/procurement-pr.service.ts': { statements: 29, branches: 61, functions: 55, lines: 29 }, // 31.9/63.6/57.1/31.9
        'src/modules/projects/projects-evm.service.ts':      { statements: 64, branches: 77, functions: 54, lines: 64 }, // 66.1/79.7/56.3/66.1
      },
    },
  },
  // decorators (@Injectable/@Inject) need experimentalDecorators when esbuild transforms TS
  esbuild: { tsconfigRaw: { compilerOptions: { experimentalDecorators: true, emitDecoratorMetadata: true } } },
});
