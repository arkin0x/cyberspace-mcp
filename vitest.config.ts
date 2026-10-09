// vitest.config.ts: the test runner's settings. Tests never touch the network;
// every relay in them is the in-memory fake under test/fakeRelay.ts.
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
