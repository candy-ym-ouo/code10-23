import type { PrismaClient } from "@prisma/client";
import type { WorkerTestInfra } from "./setup.js";

export function testInfra(): WorkerTestInfra {
  const infra = globalThis.__practiceWorkerTestInfra;
  if (!infra) throw new Error("Worker 测试基础设施未初始化：setup.ts 必须先于测试加载");
  return infra;
}

export type Db = PrismaClient;
