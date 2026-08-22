import path from 'path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['server/**/*.test.ts', 'src/**/*.test.ts'],
  },
  resolve: {
    alias: {
      '@server': path.resolve(__dirname, 'server'),
      '@app': path.resolve(__dirname, 'src'),
    },
  },
});
