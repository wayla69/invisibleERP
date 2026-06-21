import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    coverage: { provider: 'v8', reporter: ['text', 'lcov'], include: ['src/modules/tax/**', 'src/common/doc-number.service.ts'] },
  },
  // decorators (@Injectable/@Inject) need experimentalDecorators when esbuild transforms TS
  esbuild: { tsconfigRaw: { compilerOptions: { experimentalDecorators: true, emitDecoratorMetadata: true } } },
});
