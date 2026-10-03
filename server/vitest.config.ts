import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Integration tests share one database, so run files sequentially.
    fileParallelism: false,
    testTimeout: 20000,
    env: {
      DATABASE_URL:
        process.env.TEST_DATABASE_URL ?? 'postgres://feeds:feeds@localhost:5432/feeds_test',
      INGEST_IN_PROCESS: 'false',
      EXTRACT_MIN_CHARS: '200',
    },
  },
});
