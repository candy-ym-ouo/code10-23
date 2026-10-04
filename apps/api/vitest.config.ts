import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    setupFiles: ["./test/setup-env.ts"],
    globalSetup: ["./test/global-database.ts"],
    // 集成测试共用一个嵌入式 PostgreSQL，串行执行并在每个文件后清表。
    fileParallelism: false,
    hookTimeout: 120_000,
    testTimeout: 30_000,
  },
});
