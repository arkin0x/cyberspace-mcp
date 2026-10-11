// vitest.config.ts: the test runner's settings. Tests never touch the network;
// every relay in them is the in-memory fake under test/fakeRelay.ts, and
// test/noNetwork.ts makes any fetch a test did not inject fail.
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    setupFiles: ['test/noNetwork.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
