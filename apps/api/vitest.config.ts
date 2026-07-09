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

        // docs/38 sub-services: guard paths are unit-tested (test/ledger-posting.test.ts GL-05/GL-17,
        // test/procurement-po.test.ts Phase-16 screening port) but the write paths are harness-tested
        // (basics/compliance/golden) — join this gated set when the write paths get unit tests too.
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
      // Floor locked just below the measured baseline (stmts 80.3 / branch 89.2 / funcs 79.5 / lines 80.3
      // as of 2026-07-08, after the 2.4 pure-module suites). A change that drops coverage on these modules
      // FAILS the gate. Ratchet UP over time.
      thresholds: { statements: 78, branches: 87, functions: 77, lines: 78 },
    },
  },
  // decorators (@Injectable/@Inject) need experimentalDecorators when esbuild transforms TS
  esbuild: { tsconfigRaw: { compilerOptions: { experimentalDecorators: true, emitDecoratorMetadata: true } } },
});
