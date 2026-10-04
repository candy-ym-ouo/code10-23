import type { PrismaClient } from "@prisma/client";

/**
 * 将“今天 00:00 UTC 之前到期、且仍开放/进行中”的目标批量标记为 MISSED。
 *
 * 边界不变量：
 * - dueDate 是数据库 Date 列，统一按 UTC 日界处理，避免服务器时区影响；
 * - 已完成/已取消/已逾期目标绝不被重复改写；
 * - 只更新开放态目标，返回受影响行数用于可观测日志。
 */
export async function scanOverdueGoals(prisma: PrismaClient, now: Date = new Date()): Promise<number> {
  const startOfToday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const result = await prisma.goal.updateMany({
    where: {
      dueDate: { lt: startOfToday },
      status: { in: ["OPEN", "IN_PROGRESS"] },
    },
    data: { status: "MISSED" },
  });
  return result.count;
}
