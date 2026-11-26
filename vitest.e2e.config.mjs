import { defineConfig } from 'vitest/config';

// Against `docker compose --profile bakers up -d`; see README › Tests.
export default defineConfig({ test: { include: ['tests/e2e/**/*.test.mjs'], testTimeout: 300_000, hookTimeout: 300_000, fileParallelism: false } });
