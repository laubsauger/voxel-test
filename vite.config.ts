import { defineConfig } from 'vite'

export default defineConfig({
  server: { port: 5173 },
  test: {
    exclude: ['**/node_modules/**', '**/dist/**', '**/.claude/**'],
  },
})
