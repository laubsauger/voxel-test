import { defineConfig } from 'vite'

export default defineConfig({
  server: { port: 5173 },
  test: {
    exclude: ['**/node_modules/**', '**/dist/**', '**/.claude/**'],
    // CPU-heavy sim suites (Jolt WASM, water CA) share cores in a full run —
    // the 5s default flakes under contention while passing isolated
    testTimeout: 30000,
  },
})
