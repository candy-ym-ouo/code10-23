import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { scanOverdueGoals } from "../src/lib/overdue-goals.js";
import { startEmbeddedDatabase, type WorkerTestDatabase } from "./helpers/integration.js";

/**
 * 关键链路：目标逾期（Worker 每日扫描）。
 *
 * 不变量：
 * 1. UTC 日界之前到期且状态为 OPEN / IN_PROGRESS 的目标 -> MISSED；
 * 2. 到期日恰好等于“今天 UTC 00:00”的目标不算逾期（当天仍可完成）；
 * 3. ACHIEVED / CANCELLED / 已 MISSED 的目标不被扫描改写；
 * 4. 扫描幂等：重复执行返回 0 且不产生副作用。
 */
describe("关键链路：Worker 目标逾期扫描", () => {
  let db: WorkerTestDatabase;
  let prisma: PrismaClient;
  let userId: string;
  let sourceSessionId: string;

  /** UTC 时钟固定在 2026-10-04 中午，日界为 2026-10-04T00:00:00Z。 */
  const scanNow = new Date("2026-10-04T12:00:00Z");

  async function seedGoal(overrides: {
    title: string;
    dueDate: Date;
    status?: "OPEN" | "IN_PROGRESS" | "ACHIEVED" | "MISSED" | "CANCELLED";
  }) {
    return prisma.goal.create({
      data: {
        userId,
        sourceSessionId,
        title: overrides.title,
        category: "RHYTHM",
        metricType: "SPEED",
        targetValue: "100",
        unit: "bpm",
        dueDate: overrides.dueDate,
        evidenceRequirement: "NONE",
        status: overrides.status ?? "OPEN",
      },
    });
  }

  beforeAll(async () => {
    db = await startEmbeddedDatabase();
    prisma = db.prisma;
    const user = await prisma.user.create({
      data: { email: "overdue-worker@example.test", displayName: "逾期测试", passwordHash: "x" },
    });
    userId = user.id;
    const session = await prisma.practiceSession.create({
      data: { userId, title: "来源练习", instrument: "Piano", startedAt: new Date("2026-09-01T10:00:00Z") },
    });
    sourceSessionId = session.id;
  }, 120_000);

  afterAll(async () => {
    await db.stop();
  }, 60_000);

  it("只把日界前到期的开放目标标记为 MISSED，并保持其他状态不变", async () => {
    const yesterdayOpen = await seedGoal({ title: "昨天到期-OPEN", dueDate: new Date("2026-10-03T00:00:00Z") });
    const oldInProgress = await seedGoal({
      title: "上周到期-IN_PROGRESS",
      dueDate: new Date("2026-09-28T00:00:00Z"),
      status: "IN_PROGRESS",
    });
    const dueToday = await seedGoal({ title: "今天到期-不逾期", dueDate: new Date("2026-10-04T00:00:00Z") });
    const futureGoal = await seedGoal({ title: "下周到期", dueDate: new Date("2026-10-10T00:00:00Z") });
    const achievedOverdue = await seedGoal({
      title: "早已完成",
      dueDate: new Date("2026-09-01T00:00:00Z"),
      status: "ACHIEVED",
    });
    const cancelledOverdue = await seedGoal({
      title: "早已取消",
      dueDate: new Date("2026-09-01T00:00:00Z"),
      status: "CANCELLED",
    });
    const alreadyMissed = await seedGoal({
      title: "上次扫描已逾期",
      dueDate: new Date("2026-09-15T00:00:00Z"),
      status: "MISSED",
    });

    const affected = await scanOverdueGoals(prisma, scanNow);
    expect(affected, "应恰好更新两个逾期开放目标").toBe(2);

    const statusOf = async (id: string) => (await prisma.goal.findUniqueOrThrow({ where: { id } })).status;
    expect(await statusOf(yesterdayOpen.id), "昨天到期的 OPEN 必须变 MISSED").toBe("MISSED");
    expect(await statusOf(oldInProgress.id), "上周到期的 IN_PROGRESS 必须变 MISSED").toBe("MISSED");
    expect(await statusOf(dueToday.id), "到期日=UTC 今日 00:00 当天不算逾期").toBe("OPEN");
    expect(await statusOf(futureGoal.id), "未来到期目标不受影响").toBe("OPEN");
    expect(await statusOf(achievedOverdue.id), "ACHIEVED 不可被逾期扫描改写").toBe("ACHIEVED");
    expect(await statusOf(cancelledOverdue.id), "CANCELLED 不可被逾期扫描改写").toBe("CANCELLED");
    expect(await statusOf(alreadyMissed.id), "MISSED 状态保持稳定").toBe("MISSED");

    // 幂等不变量：再扫一次没有任何可更新行。
    const secondAffected = await scanOverdueGoals(prisma, scanNow);
    expect(secondAffected, "重复扫描必须幂等").toBe(0);
  });

  it("UTC 日界不受时区偏移影响（日界前后一分钟精确区分）", async () => {
    const oneMinuteBefore = await seedGoal({
      title: "日界前一分钟",
      dueDate: new Date("2026-10-03T23:59:00Z"),
    });
    const atMidnight = await seedGoal({
      title: "日界整刻",
      dueDate: new Date("2026-10-04T00:00:00Z"),
    });
    const affected = await scanOverdueGoals(prisma, scanNow);
    expect(affected).toBe(1);
    const before = await prisma.goal.findUniqueOrThrow({ where: { id: oneMinuteBefore.id } });
    const atZero = await prisma.goal.findUniqueOrThrow({ where: { id: atMidnight.id } });
    expect(before.status).toBe("MISSED");
    expect(atZero.status).toBe("OPEN");
  });
});
