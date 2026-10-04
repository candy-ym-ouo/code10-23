import type { PrismaClient } from "@prisma/client";

/**
 * 将所有「截止日期早于今日 UTC 零点」且仍处于开放/进行中的目标标记为 MISSED。
 * 已完成、已取消或已逾期的目标不受影响；截止日为今天的目标仍有当天时间完成，不视为逾期。
 * 返回被批量更新的行数，供调用方记录日志。
 */
export async function markOverdueGoalsMissed(prisma: PrismaClient, now: Date = new Date()): Promise<number> {
  const startOfToday = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0),
  );
  const result = await prisma.goal.updateMany({
    where: {
      dueDate: { lt: startOfToday },
      status: { in: ["OPEN", "IN_PROGRESS"] },
    },
    data: { status: "MISSED" },
  });
  return result.count;
}
