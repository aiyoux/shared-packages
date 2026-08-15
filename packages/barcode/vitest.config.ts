import { defineConfig } from 'vitest/config';

export default defineConfig({
  assetsInclude: ['**/*.wasm'],
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000
  }
});
