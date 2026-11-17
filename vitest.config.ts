import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    // Tests hors ligne : les clés de `.env` ne sont jamais lues (valeur vide = absente).
    env: { OPENROUTER_API_KEY: '' },
  },
});
