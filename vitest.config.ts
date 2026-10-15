import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    env: { APP_ENV: 'test' },
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
