/**
 * Worker 集成测试夹具：每个测试文件一个隔离的嵌入式 PostgreSQL 实例。
 * 迁移直接复用 apps/api/prisma/migrations，保证 Worker 面对的是真实生产表结构。
 */
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import { PrismaClient } from "@prisma/client";

const MIGRATIONS_DIR = path.resolve(import.meta.dirname, "../../../api/prisma/migrations");

let nextPort = 56_000;

export interface WorkerTestDatabase {
  prisma: PrismaClient;
  stop: () => Promise<void>;
}

export async function startEmbeddedDatabase(): Promise<WorkerTestDatabase> {
  // worker/src/config/env.ts 在仅导入 Prisma 时不会被加载，但为未来直接测试任务函数预留完整环境。
  Object.assign(process.env, {
    NODE_ENV: "test",
    REDIS_URL: "redis://localhost:6379",
    S3_ENDPOINT: "http://s3.test.local",
    S3_REGION: "us-east-1",
    S3_BUCKET: "practice-test-audio",
    S3_ACCESS_KEY: "test-access-key",
    S3_SECRET_KEY: "test-secret-key",
    S3_FORCE_PATH_STYLE: "true",
    LOG_LEVEL: "silent",
  });

  const port = nextPort++;
  const dataDir = await mkdtemp(path.join(tmpdir(), `practice-worker-pg-${port}-`));
  const pg = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: "postgres",
    password: "postgres",
    port,
    persistent: false,
    authMethod: "password",
    initdbFlags: ["--encoding=UTF8", "--locale=C"],
    onLog: () => undefined,
    onError: () => undefined,
  });
  await pg.initialise();
  await pg.start();
  process.env.DATABASE_URL = `postgresql://postgres:postgres@127.0.0.1:${port}/postgres?schema=public`;

  const pgNode = await import("pg");
  const client = new pgNode.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  const migrations = (await readdir(MIGRATIONS_DIR, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  for (const migration of migrations) {
    const sql = await readFile(path.join(MIGRATIONS_DIR, migration, "migration.sql"), "utf8");
    await client.query(sql);
  }
  await client.end();

  const { prisma } = await import("../../src/lib/prisma.js");
  const stop = async () => {
    await prisma.$disconnect();
    await pg.stop();
    await rm(dataDir, { recursive: true, force: true });
  };
  return { prisma, stop };
}
