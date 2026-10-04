import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import EmbeddedPostgres from "embedded-postgres";

const MIGRATIONS_DIR = path.resolve(import.meta.dirname, "../prisma/migrations");
export const TEST_PORT = 55_666;
export const TEST_DATABASE_URL =
  `postgresql://postgres:postgres@127.0.0.1:${TEST_PORT}/postgres?schema=public`;

/**
 * 全局夹具：整轮测试共享一个隔离的嵌入式 PostgreSQL。
 * - 启动时按顺序执行 prisma/migrations，结构与生产完全一致；
 * - 表数据由 setup-env.ts 在每个测试文件开始前 TRUNCATE，保证文件间隔离；
 * - 整轮结束关闭进程并删除数据目录，机器上不残留任何状态。
 */
export default async function setup() {
  process.env.DATABASE_URL = TEST_DATABASE_URL;
  const dataDir = await mkdtemp(path.join(tmpdir(), "practice-api-test-pg-"));
  const pg = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: "postgres",
    password: "postgres",
    port: TEST_PORT,
    persistent: false,
    authMethod: "password",
    initdbFlags: ["--encoding=UTF8", "--locale=C"],
    onLog: () => undefined,
    onError: () => undefined,
  });
  await pg.initialise();
  await pg.start();

  const { default: pgNode } = await import("pg");
  const client = new pgNode.Client({ connectionString: TEST_DATABASE_URL });
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

  return async () => {
    await pg.stop();
    await rm(dataDir, { recursive: true, force: true });
  };
}
