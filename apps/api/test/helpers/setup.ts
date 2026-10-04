/**
 * Vitest setupFile：在任何测试模块（及其静态 import 的 src 业务模块）求值之前，
 * 以顶层 await 启动进程内 PGlite，并把带驱动适配器的 PrismaClient 注入
 * src/lib/prisma.ts 使用的 globalThis.__practicePrisma 槽位。
 *
 * 注意：初始化不能放在 beforeAll 中——测试文件的静态 import 在钩子调度前
 * 就会触发 src/lib/prisma.ts 求值并创建单例。
 *
 * Vitest 按测试文件隔离模块注册表并保证 setupFile 先于测试模块完成求值，
 * 因此天然实现“一个测试文件 = 一个全新内存数据库”的隔离。
 */
import { afterAll } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import "./env.js";

const migrationsDir = fileURLToPath(new URL("../../prisma/migrations", import.meta.url));

declare global {
  // eslint-disable-next-line no-var
  var __practiceTestInfra: TestInfra | undefined;
}

export interface TestInfra {
  prisma: PrismaClient;
  resetDatabase: () => Promise<void>;
}

const TABLE_NAMES = [
  "audit_logs",
  "data_exports",
  "goal_progress",
  "goals",
  "session_reviews",
  "annotations",
  "media_assets",
  "practice_sessions",
  "refresh_sessions",
  "users",
];

async function applyMigrations(pg: PGlite): Promise<void> {
  const dirs = readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  for (const dir of dirs) {
    const sql = readFileSync(join(migrationsDir, dir, "migration.sql"), "utf8");
    await pg.exec(sql);
  }
}

// ---- 顶层初始化（先于测试模块求值） ----
const pg = new PGlite();
const socketServer = new PGLiteSocketServer({
  db: pg as never,
  host: "127.0.0.1",
  port: 0,
  // Prisma 连接池与并发 HTTP 请求需要多个连接；PGlite 端会自行串行化执行。
  maxConnections: 16,
});
await socketServer.start();
const [host, portText] = socketServer.getServerConn().split(":") as [string, string];
const adapter = new PrismaPg({
  connectionString: `postgresql://postgres:postgres@${host}:${portText}/postgres`,
});
const prisma = new PrismaClient({ adapter, log: ["error"] });
await applyMigrations(pg);

const infra: TestInfra = {
  prisma,
  resetDatabase: async () => {
    await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${TABLE_NAMES.join(", ")} RESTART IDENTITY CASCADE`);
  },
};

// src/lib/prisma.ts 在非生产环境读取该全局槽位；必须在业务模块求值前就位。
globalThis.__practicePrisma = prisma as never;
globalThis.__practiceTestInfra = infra;

afterAll(async () => {
  await prisma.$disconnect();
  await socketServer.stop();
  await pg.close();
  globalThis.__practicePrisma = undefined;
  globalThis.__practiceTestInfra = undefined;
});
