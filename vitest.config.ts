import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'qa/**/*.test.mjs'],
    environment: 'node',
  },
});
