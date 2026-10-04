/**
 * Vitest setup：在任何被测模块被静态导入之前提供环境变量，
 * 让 src/config/env.ts 与 src/lib/prisma.ts 的模块级初始化通过校验。
 *
 * DATABASE_URL 固定指向 test/global-database.ts 的 globalSetup 启动的
 * 嵌入式 PostgreSQL（同一端口）。该实例仅在测试运行期间存活。
 */
process.env.NODE_ENV = "test";
process.env.API_PORT = "3000";
process.env.DATABASE_URL ??= "postgresql://postgres:postgres@127.0.0.1:55666/postgres?schema=public";
process.env.REDIS_URL ??= "redis://localhost:6379";
process.env.JWT_ACCESS_SECRET ??= "test-access-secret-at-least-32-characters-xxxx";
process.env.REFRESH_TOKEN_PEPPER ??= "test-refresh-pepper-at-least-32-characters-x";
process.env.ACCESS_TOKEN_TTL ??= "15m";
process.env.REFRESH_TOKEN_TTL ??= "30d";
process.env.S3_ENDPOINT ??= "http://s3.test.local";
process.env.S3_REGION ??= "us-east-1";
process.env.S3_BUCKET ??= "practice-test-audio";
process.env.S3_ACCESS_KEY ??= "test-access-key";
process.env.S3_SECRET_KEY ??= "test-secret-key";
process.env.S3_FORCE_PATH_STYLE ??= "true";
process.env.PUBLIC_API_ORIGIN ??= "http://localhost:3000";
process.env.WEB_ORIGIN ??= "http://localhost:5173";
process.env.METRICS_ENABLED ??= "false";
process.env.LOG_LEVEL ??= "silent";

/**
 * 文件级隔离：每个测试文件开始前 TRUNCATE 全部业务表。
 * 测试文件串行执行（vitest.config 的 fileParallelism: false），
 * 因此这里无需与其他文件协调。
 */
import { beforeAll } from "vitest";

beforeAll(async () => {
  const { default: pgNode } = await import("pg");
  const client = new pgNode.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  await client.query(`
    DO $$
    DECLARE r record;
    BEGIN
      FOR r IN
        SELECT tablename FROM pg_tables WHERE schemaname = 'public'
      LOOP
        EXECUTE format('TRUNCATE TABLE %I RESTART IDENTITY CASCADE', r.tablename);
      END LOOP;
    END $$;
  `);
  await client.end();
});

