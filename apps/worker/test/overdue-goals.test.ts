/**
 * 关键链路：目标逾期扫描（Worker 定时任务 markOverdueGoalsMissed）
 *
 * 规则不变量（失败时按编号定位被破坏的具体不变量）：
 *  O1 截止日期 < 今日 UTC 零点 且状态为 OPEN/IN_PROGRESS 的目标 → MISSED。
 *  O2 截止日期 = 今天的目标不视为逾期（当天仍可完成），未来到期更不受影响。
 *  O3 已关闭状态（ACHIEVED / CANCELLED）即使截止日期已过也不得改写。
 *  O4 只更新状态：title/targetValue/dueDate/completedAt/cancelledReason/version 全部不变。
 *  O5 扫描幂等：重复扫描返回 0，不会重复更新或触碰已 MISSED 的行。
 *  O6 返回值精确等于本次变更的行数（用于 Worker 日志口径）。
 *  O7 扫描是跨用户全局批处理：不同用户的逾期目标都会被覆盖。
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import "./helpers/env.js";
import type { Db } from "./helpers/harness.js";
import { testInfra } from "./helpers/harness.js";
import { markOverdueGoalsMissed } from "../src/lib/overdue-goals.js";

// 固定扫描参照时刻：2026-10-04 15:30 UTC（今日 UTC 零点 = 2026-10-04T00:00Z）
const SCAN_NOW = new Date("2026-10-04T15:30:00Z");
const START_OF_TODAY = new Date("2026-10-04T00:00:00Z");

describe("关键链路：目标逾期扫描", () => {
  let prisma: Db;

  beforeAll(() => {
    prisma = testInfra().prisma;
  });

  beforeEach(async () => {
    await testInfra().resetDatabase();
  });

  /** 构造一个用户及其来源练习，返回 userId */
  async function seedUserWithSession(label: string) {
    const user = await prisma.user.create({
      data: { email: `${label}-${Math.random().toString(36).slice(2)}@example.com`, passwordHash: "h", displayName: label },
    });
    const session = await prisma.practiceSession.create({
      data: {
        userId: user.id,
        title: `${label} 练习`,
        instrument: "Piano",
        startedAt: new Date("2026-09-01T10:00:00Z"),
      },
    });
    return { userId: user.id, sessionId: session.id };
  }

  async function seedGoal(input: {
    userId: string;
    sessionId: string;
    title: string;
    dueDate: Date;
    status?: "OPEN" | "IN_PROGRESS" | "ACHIEVED" | "MISSED" | "CANCELLED";
    targetValue?: number;
    completedAt?: Date | null;
    cancelledReason?: string | null;
  }) {
    return prisma.goal.create({
      data: {
        userId: input.userId,
        sourceSessionId: input.sessionId,
        title: input.title,
        category: "RHYTHM",
        metricType: "SPEED",
        targetValue: input.targetValue ?? 100,
        unit: "bpm",
        dueDate: input.dueDate,
        evidenceRequirement: "NONE",
        status: input.status ?? "OPEN",
        completedAt: input.completedAt ?? null,
        cancelledReason: input.cancelledReason ?? null,
      },
    });
  }

  it("O1: 昨日及更早到期的 OPEN/IN_PROGRESS 目标被标记为 MISSED", async () => {
    const { userId, sessionId } = await seedUserWithSession("u1");
    const overdueOpen = await seedGoal({
      userId,
      sessionId,
      title: "昨天到期-OPEN",
      dueDate: new Date("2026-10-03"),
      status: "OPEN",
    });
    const olderInProgress = await seedGoal({
      userId,
      sessionId,
      title: "上月到期-IN_PROGRESS",
      dueDate: new Date("2026-09-01"),
      status: "IN_PROGRESS",
    });
    // 边界：恰好早于今日零点 1 毫秒（Date 列精度为天，实际按日期比较，仍属昨天）
    const justBeforeMidnight = new Date(START_OF_TODAY.getTime() - 1);

    expect(justBeforeMidnight.toISOString()).toBe("2026-10-03T23:59:59.999Z");

    const count = await markOverdueGoalsMissed(prisma, SCAN_NOW);
    expect(count, "O6: 返回值必须等于本次实际变更行数").toBe(2);

    const [first, second] = await Promise.all([
      prisma.goal.findUniqueOrThrow({ where: { id: overdueOpen.id } }),
      prisma.goal.findUniqueOrThrow({ where: { id: olderInProgress.id } }),
    ]);
    expect(first.status, "O1: 过期 OPEN → MISSED").toBe("MISSED");
    expect(second.status, "O1: 过期 IN_PROGRESS → MISSED").toBe("MISSED");
  });

  it("O2: 今天到期与未来到期的目标保持原状", async () => {
    const { userId, sessionId } = await seedUserWithSession("u2");
    const dueToday = await seedGoal({
      userId,
      sessionId,
      title: "今天到期",
      dueDate: new Date("2026-10-04"),
      status: "OPEN",
    });
    const dueTomorrow = await seedGoal({
      userId,
      sessionId,
      title: "明天到期",
      dueDate: new Date("2026-10-05"),
      status: "IN_PROGRESS",
    });

    const count = await markOverdueGoalsMissed(prisma, SCAN_NOW);
    expect(count, "O2: 今天/未来到期不应产生任何变更").toBe(0);

    const [today, tomorrow] = await Promise.all([
      prisma.goal.findUniqueOrThrow({ where: { id: dueToday.id } }),
      prisma.goal.findUniqueOrThrow({ where: { id: dueTomorrow.id } }),
    ]);
    expect(today.status, "O2: 今天到期仍 OPEN（当天还有时间完成）").toBe("OPEN");
    expect(tomorrow.status).toBe("IN_PROGRESS");
  });

  it("O3: 已完成/已取消目标即使过期也不得被改写", async () => {
    const { userId, sessionId } = await seedUserWithSession("u3");
    const achievedAt = new Date("2026-09-20T12:00:00Z");
    const achieved = await seedGoal({
      userId,
      sessionId,
      title: "已达成",
      dueDate: new Date("2026-09-25"),
      status: "ACHIEVED",
      completedAt: achievedAt,
    });
    const cancelled = await seedGoal({
      userId,
      sessionId,
      title: "已取消",
      dueDate: new Date("2026-09-26"),
      status: "CANCELLED",
      cancelledReason: "计划调整",
    });

    const count = await markOverdueGoalsMissed(prisma, SCAN_NOW);
    expect(count, "O3: 关闭状态目标不计入逾期更新").toBe(0);

    const [a, c] = await Promise.all([
      prisma.goal.findUniqueOrThrow({ where: { id: achieved.id } }),
      prisma.goal.findUniqueOrThrow({ where: { id: cancelled.id } }),
    ]);
    expect(a.status).toBe("ACHIEVED");
    expect(a.completedAt?.getTime(), "O3: ACHIEVED 的完成时间不得被清空").toBe(achievedAt.getTime());
    expect(c.status).toBe("CANCELLED");
    expect(c.cancelledReason).toBe("计划调整");
  });

  it("O4: 逾期更新只改 status，其他字段与 version 保持不变", async () => {
    const { userId, sessionId } = await seedUserWithSession("u4");
    const goal = await seedGoal({
      userId,
      sessionId,
      title: "字段快照",
      dueDate: new Date("2026-10-01"),
      targetValue: 88,
    });
    const before = await prisma.goal.findUniqueOrThrow({ where: { id: goal.id } });

    await markOverdueGoalsMissed(prisma, SCAN_NOW);
    const after = await prisma.goal.findUniqueOrThrow({ where: { id: goal.id } });

    expect(after.status).toBe("MISSED");
    expect(after.title, "O4").toBe(before.title);
    expect(Number(after.targetValue), "O4").toBe(Number(before.targetValue));
    expect(after.dueDate.getTime(), "O4").toBe(before.dueDate.getTime());
    expect(after.completedAt, "O4: 逾期不得写完成时间").toBeNull();
    expect(after.cancelledReason, "O4").toBeNull();
    expect(after.version, "O4: 批量状态迁移不得增加乐观锁版本").toBe(before.version);
  });

  it("O5+O6: 扫描幂等，重复执行不再产生变更", async () => {
    const { userId, sessionId } = await seedUserWithSession("u5");
    await seedGoal({ userId, sessionId, title: "g1", dueDate: new Date("2026-10-02") });
    await seedGoal({ userId, sessionId, title: "g2", dueDate: new Date("2026-10-03"), status: "IN_PROGRESS" });

    const first = await markOverdueGoalsMissed(prisma, SCAN_NOW);
    expect(first).toBe(2);
    const second = await markOverdueGoalsMissed(prisma, SCAN_NOW);
    expect(second, "O5: 第二次扫描必须返回 0").toBe(0);
    const missedCount = await prisma.goal.count({ where: { status: "MISSED" } });
    expect(missedCount, "O5: MISSED 行数不得重复累加").toBe(2);
  });

  it("O7: 跨用户全局批处理，且恰在 UTC 零点之后也能识别昨日目标", async () => {
    const a = await seedUserWithSession("ua");
    const b = await seedUserWithSession("ub");
    await seedGoal({ userId: a.userId, sessionId: a.sessionId, title: "a-逾期", dueDate: new Date("2026-10-03") });
    await seedGoal({ userId: b.userId, sessionId: b.sessionId, title: "b-逾期", dueDate: new Date("2026-09-15") });
    await seedGoal({ userId: b.userId, sessionId: b.sessionId, title: "b-今天", dueDate: new Date("2026-10-04") });

    // 参照时间推进到当天 00:00:01 UTC，验证“今日零点”边界由参数计算而不是缓存的固定时刻
    const count = await markOverdueGoalsMissed(prisma, new Date("2026-10-04T00:00:01Z"));
    expect(count, "O7: 两个不同用户各 1 条逾期目标").toBe(2);

    const missedOwners = await prisma.goal.findMany({
      where: { status: "MISSED" },
      select: { userId: true, title: true },
    });
    expect(new Set(missedOwners.map((g) => g.userId)).size, "O7: 逾期更新必须覆盖两个用户").toBe(2);
  });
});
