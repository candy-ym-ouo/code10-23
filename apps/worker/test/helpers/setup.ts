/**
 * Vitest setupFile：在测试模块求值前以顶层 await 启动进程内 PGlite，
 * 应用 API 包的同一套迁移，并导出共享的测试基础设施类型。
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

// 复用 API 包的 Prisma 迁移目录（schema 的唯一事实来源）
const migrationsDir = fileURLToPath(new URL("../../../api/prisma/migrations", import.meta.url));

declare global {
  // eslint-disable-next-line no-var
  var __practiceWorkerTestInfra: WorkerTestInfra | undefined;
}

export interface WorkerTestInfra {
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

const pg = new PGlite();
const socketServer = new PGLiteSocketServer({
  db: pg as never,
  host: "127.0.0.1",
  port: 0,
  maxConnections: 16,
});
await socketServer.start();
const [host, portText] = socketServer.getServerConn().split(":") as [string, string];
const adapter = new PrismaPg({
  connectionString: `postgresql://postgres:postgres@${host}:${portText}/postgres`,
});
const prisma = new PrismaClient({ adapter, log: ["error"] });
await applyMigrations(pg);

const infra: WorkerTestInfra = {
  prisma,
  resetDatabase: async () => {
    await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${TABLE_NAMES.join(", ")} RESTART IDENTITY CASCADE`);
  },
};
globalThis.__practiceWorkerTestInfra = infra;

afterAll(async () => {
  await prisma.$disconnect();
  await socketServer.stop();
  await pg.close();
  globalThis.__practiceWorkerTestInfra = undefined;
});
