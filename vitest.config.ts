import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    // Les serveurs de test écoutent sur la boucle locale, y compris dans l’image Docker.
    env: { OPENROUTER_API_KEY: '', WEB_HOST: '127.0.0.1', RAGATOR_BIND_ADDRESS: '127.0.0.1' },
  },
});
