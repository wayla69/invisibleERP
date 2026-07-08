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
      // Floor locked just below the measured baseline (stmts 63 / branch 80 / funcs 66 / lines 63 as of
      // 2026-06-30). A change that drops coverage on these modules FAILS the gate. Ratchet UP over time.
      thresholds: { statements: 60, branches: 75, functions: 62, lines: 60 },
    },
  },
  // decorators (@Injectable/@Inject) need experimentalDecorators when esbuild transforms TS
  esbuild: { tsconfigRaw: { compilerOptions: { experimentalDecorators: true, emitDecoratorMetadata: true } } },
});
