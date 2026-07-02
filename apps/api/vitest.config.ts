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
        'src/modules/tax/**',
        'src/common/doc-number.service.ts',
        'src/common/ai-models.ts',
        'src/common/pii-redact.ts',
        'src/common/crypto.ts',
        'src/common/money.ts',
        'src/database/encrypted-column.ts',
        'src/observability/runtime-metrics.ts',
      ],
      exclude: ['**/*.module.ts'], // Nest module decorators carry no testable logic
      // Floor locked just below the measured baseline (stmts 63 / branch 80 / funcs 66 / lines 63 as of
      // 2026-06-30). A change that drops coverage on these modules FAILS the gate. Ratchet UP over time.
      thresholds: { statements: 60, branches: 75, functions: 62, lines: 60 },
    },
  },
  // decorators (@Injectable/@Inject) need experimentalDecorators when esbuild transforms TS
  esbuild: { tsconfigRaw: { compilerOptions: { experimentalDecorators: true, emitDecoratorMetadata: true } } },
});
