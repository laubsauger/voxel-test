import { defineConfig } from 'vite'

export default defineConfig({
  base: process.env.GITHUB_PAGES === 'true' ? '/voxel-test/' : '/',
  server: { port: 5173 },
  // T78 — Box3D spike is a second entry page (box3d-spike.html), isolated from
  // the game's index.html (V14). Both must be built.
  build: {
    rollupOptions: {
      input: {
        main: 'index.html',
        box3dSpike: 'box3d-spike.html',
      },
    },
  },
  test: {
    exclude: ['**/node_modules/**', '**/dist/**', '**/.claude/**'],
    // CPU-heavy sim suites (Jolt WASM, water CA) share cores in a full run —
    // the 5s default flakes under contention while passing isolated
    testTimeout: 30000,
  },
})
