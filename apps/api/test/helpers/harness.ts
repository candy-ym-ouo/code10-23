import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { buildApp } from "../../src/app.js";
import type { TestInfra } from "./setup.js";

/**
 * 集成测试上下文：
 * - Prisma/PGlite 由 setup.ts（beforeAll）创建，每个测试文件一个全新内存库；
 * - Fastify 应用在文件内惰性构建一次，用例之间复用，数据库用 TRUNCATE 隔离；
 * - 不依赖真实 PostgreSQL、Redis、S3（被测路径均不触发这些外部连接）。
 */
export interface IntegrationContext {
  app: FastifyInstance;
  prisma: PrismaClient;
  resetDatabase: () => Promise<void>;
  close: () => Promise<void>;
}

function testInfra(): TestInfra {
  const infra = globalThis.__practiceTestInfra;
  if (!infra) throw new Error("测试基础设施未初始化：setup.ts 必须先于测试加载");
  return infra;
}

export async function createIntegrationContext(): Promise<IntegrationContext> {
  const infra = testInfra();
  const app = await buildApp();
  return {
    app,
    prisma: infra.prisma,
    resetDatabase: infra.resetDatabase,
    close: async () => {
      // app.close 会通过 prisma 插件的 onClose 断开当前文件的 Prisma 连接。
      await app.close();
    },
  };
}
