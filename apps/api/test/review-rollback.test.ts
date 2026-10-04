/**
 * 关键链路：复盘关闭（completeSession）事务原子性、乐观并发与回滚
 *
 * 路由 POST /sessions/:id/complete 必须在单个 Prisma 事务中完成：
 * 状态机推进（version 乐观锁）→ 复盘 upsert → 新目标创建 → 旧目标进度写入。
 *
 * 业务不变量（失败时按编号定位被破坏的具体不变量）：
 *  R1 【回滚】事务进行到任意一步失败，此前已执行的步骤必须全部回滚：
 *     练习状态仍为 IN_REVIEW、version 不增加、completedAt 为空、
 *     复盘不被标记完成、不得残留半截创建的目标/进度。
 *  R2 【乐观锁】并发的两次关闭使用同一 version，只能成功一次：
 *     成功者 COMPLETED 且 version+1；失败者 409 VERSION_CONFLICT 且不得重复关闭/重复建行。
 *  R3 【缺项拒绝】复盘闭环缺项（无标记且未声明无异常、缺少下次重点、缺少目标/进度）
 *     必须返回 400 REVIEW_INCOMPLETE，且练习状态与 version 不变。
 *  R4 【正常关闭】满足全部条件时一次性原子完成：COMPLETED、completedAt、
 *     时长按 READY 音频合计、复盘落库、新目标创建、旧目标状态推进且有进度记录。
 *  R5 【重复关闭】已 COMPLETED 的练习再次完成必须 409 INVALID_SESSION_STATE。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import "./helpers/env.js";
import type { IntegrationContext } from "./helpers/harness.js";
import { createIntegrationContext } from "./helpers/harness.js";
import { apiCall, registerUser } from "./helpers/client.js";
import { seedSession } from "./helpers/seed.js";

// 不触碰 Redis（完成链路不依赖队列；S3 也不被调用）
vi.mock("../src/lib/queue.js", () => ({
  enqueueProbe: vi.fn(async () => undefined),
  enqueueCleanup: vi.fn(async () => undefined),
  enqueueExport: vi.fn(async () => undefined),
  closeQueue: vi.fn(async () => undefined),
}));

interface ReadyFixture {
  userId: string;
  accessToken: string;
  sessionId: string;
  mediaId: string;
  annotationId: string;
  openGoalId: string;
  /** 构造一个默认合法的完成请求体 */
  validPayload: (overrides?: Record<string, unknown>) => Record<string, unknown>;
}

describe("关键链路：复盘关闭与回滚", () => {
  let ctx: IntegrationContext;

  beforeAll(async () => {
    ctx = await createIntegrationContext();
  });

  beforeEach(async () => {
    await ctx.resetDatabase();
  });

  afterAll(async () => {
    await ctx.close();
  });

  /**
   * 构造一个满足关闭前置条件的练习：
   * IN_REVIEW、1 条 READY 音频（12s）、1 个问题标记、1 个既有开放目标。
   */
  async function seedReadySession(version = 0): Promise<ReadyFixture> {
    const user = await registerUser(ctx.app, `ready-${Math.random().toString(36).slice(2)}`);
    const session = await seedSession(ctx.prisma, {
      userId: user.userId,
      status: "IN_REVIEW",
      version,
    });
    const media = await ctx.prisma.mediaAsset.create({
      data: {
        userId: user.userId,
        sessionId: session.id,
        status: "READY",
        objectKey: `users/${user.userId}/sessions/${session.id}/ready.wav`,
        originalName: "ready.wav",
        mimeType: "audio/wav",
        sizeBytes: 1000n,
        sha256: "a".repeat(64),
        durationMs: 12_000n,
        processedAt: new Date("2026-09-01T10:06:00Z"),
      },
    });
    const annotation = await ctx.prisma.annotation.create({
      data: {
        userId: user.userId,
        sessionId: session.id,
        mediaId: media.id,
        type: "RHYTHM",
        severity: 3,
        startMs: 1000n,
        endMs: 3000n,
        title: "抢拍",
      },
    });
    const goal = await ctx.prisma.goal.create({
      data: {
        userId: user.userId,
        sourceSessionId: session.id,
        title: "节拍器 60bpm 稳定演奏",
        category: "RHYTHM",
        metricType: "SPEED",
        targetValue: 60,
        unit: "bpm",
        dueDate: new Date("2026-10-10"),
        evidenceRequirement: "NONE",
      },
    });

    return {
      userId: user.userId,
      accessToken: user.accessToken,
      sessionId: session.id,
      mediaId: media.id,
      annotationId: annotation.id,
      openGoalId: goal.id,
      validPayload: (overrides = {}) => ({
        version,
        review: {
          goodPoints: "慢练时节奏稳定",
          mainIssues: "提速后第 4 小节抢拍",
          nextFocus: "以 60bpm 节拍器分段慢练第 4 小节",
          noIssues: false,
          suggestedNextPracticeAt: "2026-10-05T10:00:00.000Z",
        },
        goalCreates: [],
        goalProgressUpdates: [
          {
            goalId: goal.id,
            actualValue: 52,
            note: "本次能稳定到 52bpm",
          },
        ],
        ...overrides,
      }),
    };
  }

  const complete = (fix: ReadyFixture, payload: unknown) =>
    apiCall(ctx.app, {
      method: "POST",
      url: `/api/v1/sessions/${fix.sessionId}/complete`,
      accessToken: fix.accessToken,
      payload,
    });

  it("R1: 事务中途（创建第二个目标）失败必须整体回滚，不留半截状态", async () => {
    const fix = await seedReadySession(0);
    const payload = fix.validPayload({
      goalCreates: [
        {
          title: "新目标一",
          category: "PITCH",
          metricType: "ACCURACY",
          targetValue: 90,
          unit: "%",
          dueDate: "2026-10-20",
          evidenceRequirement: "SELF_REVIEW",
        },
        {
          title: "新目标二（触发失败）",
          category: "SPEED",
          metricType: "SPEED",
          targetValue: 100,
          unit: "bpm",
          dueDate: "2026-10-21",
          evidenceRequirement: "NONE",
        },
      ],
    });

    // 在事务执行到“第二个目标创建”时注入一次数据库级故障
    const originalTransaction = ctx.prisma.$transaction.bind(ctx.prisma);
    const spy = vi.spyOn(ctx.prisma, "$transaction").mockImplementation(async (arg: unknown) => {
      return originalTransaction(async (tx) => {
        const txAny = tx as { goal: { create: (args: unknown) => Promise<unknown> } };
        const originalCreate = txAny.goal.create.bind(txAny.goal);
        let calls = 0;
        txAny.goal.create = vi.fn(async (args) => {
          calls += 1;
          if (calls === 2) throw new Error("injected mid-transaction failure");
          return originalCreate(args);
        });
        return (arg as (t: typeof tx) => Promise<unknown>)(tx);
      });
    });

    // 注入的故障会被全局错误处理器记录为 500 日志，这里静音以免污染测试输出
    const logger = ctx.app.log;
    const logSpy = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    let response;
    try {
      response = await complete(fix, payload);
    } finally {
      logSpy.mockRestore();
    }
    spy.mockRestore();

    expect(response.status, "R1: 事务内故障必须表现为 5xx，而不是伪成功").toBe(500);

    const session = await ctx.prisma.practiceSession.findUniqueOrThrow({ where: { id: fix.sessionId } });
    expect(session.status, "R1: 状态推进必须回滚为 IN_REVIEW").toBe("IN_REVIEW");
    expect(session.version, "R1: version 递增必须回滚").toBe(0);
    expect(session.completedAt, "R1: completedAt 必须为空").toBeNull();

    const goals = await ctx.prisma.goal.findMany({ where: { sourceSessionId: fix.sessionId } });
    expect(goals, "R1: 不得残留半截创建的目标（仅保留既有开放目标）").toHaveLength(1);
    expect(goals[0]!.id, "R1: 仅保留事务前已存在的目标").toBe(fix.openGoalId);

    const review = await ctx.prisma.sessionReview.findUnique({ where: { sessionId: fix.sessionId } });
    expect(review, "R1: 复盘 upsert 必须随事务回滚").toBeNull();

    // 回滚后系统仍可在修复后正常完成（证明没有毒化连接/状态）
    const retry = await complete(fix, fix.validPayload());
    expect(retry.status, "R1: 回滚后应能重新提交并成功").toBe(200);
  });

  it("R2: 并发同 version 的两次关闭只有一次成功，另一次版本冲突", async () => {
    const fix = await seedReadySession(0);
    const payload = fix.validPayload();

    const [first, second] = await Promise.all([complete(fix, payload), complete(fix, payload)]);
    const statuses = [first.status, second.status].sort();
    expect(statuses, "R2: 必须恰好一个 200、一个 409").toEqual([200, 409]);

    const conflict = first.status === 409 ? first : second;
    expect(conflict.body).toMatchObject({ error: expect.objectContaining({ code: "VERSION_CONFLICT" }) });

    const session = await ctx.prisma.practiceSession.findUniqueOrThrow({ where: { id: fix.sessionId } });
    expect(session.status, "R2: 练习最终必须是 COMPLETED").toBe("COMPLETED");
    expect(session.version, "R2: version 只允许递增一次").toBe(1);

    const progressCount = await ctx.prisma.goalProgress.count({ where: { goalId: fix.openGoalId } });
    expect(progressCount, "R2: 失败的那次不得重复写入进度").toBe(1);
    const review = await ctx.prisma.sessionReview.findUniqueOrThrow({ where: { sessionId: fix.sessionId } });
    expect(review.completedAt, "R2: 复盘只完成一次").toBeTruthy();
  });

  it("R3: 缺少闭环要素时 REVIEW_INCOMPLETE 拒绝，状态与版本不变", async () => {
    const fix = await seedReadySession(0);
    // 移除问题标记，配合 noIssues=false 暴露“标记/无异常”缺口
    await ctx.prisma.annotation.deleteMany({ where: { sessionId: fix.sessionId } });
    // 字段层合法（有下次重点，能通过 Zod），但领域闭环缺项：
    // 未声明无异常且未补标记、也没有记录既有开放目标的进度
    const payload = fix.validPayload({
      review: {
        goodPoints: null,
        mainIssues: null,
        nextFocus: "继续慢练",
        noIssues: false,
      },
      goalCreates: [],
      goalProgressUpdates: [],
    });

    const before = await ctx.prisma.practiceSession.findUniqueOrThrow({ where: { id: fix.sessionId } });
    const response = await complete(fix, payload);

    expect(response.status, "R3: 缺项必须返回 400").toBe(400);
    expect(response.body).toMatchObject({ error: expect.objectContaining({ code: "REVIEW_INCOMPLETE" }) });
    const missing = (response.body as { error: { details?: string[] } }).error.details;
    expect(missing, "R3: 必须回传具体缺失的不变量，便于客户端逐项补齐").toBeInstanceOf(Array);
    expect(missing, "R3: 必须指出“未记录问题标记/未声明无异常”这一缺口").toEqual(
      expect.arrayContaining([expect.stringContaining("标记")]),
    );
    expect(missing, "R3: 必须指出“缺少目标进度”这一缺口").toEqual(
      expect.arrayContaining([expect.stringContaining("进度")]),
    );
    const after = await ctx.prisma.practiceSession.findUniqueOrThrow({ where: { id: fix.sessionId } });
    expect(after.status, "R3: 状态不得变化").toBe(before.status);
    expect(after.version, "R3: version 不得变化").toBe(before.version);
    expect(await ctx.prisma.sessionReview.findUnique({ where: { sessionId: fix.sessionId } }), "R3: 不得写入复盘").toBeNull();
  });

  it("R4: 满足全部条件时一次性原子关闭并聚合音频时长", async () => {
    const fix = await seedReadySession(0);
    // 再加一段 READY 音频（18s），验证时长合计 12s + 18s = 30s
    await ctx.prisma.mediaAsset.create({
      data: {
        userId: fix.userId,
        sessionId: fix.sessionId,
        status: "READY",
        objectKey: `users/${fix.userId}/sessions/${fix.sessionId}/second.wav`,
        originalName: "second.wav",
        mimeType: "audio/wav",
        sizeBytes: 2000n,
        sha256: "b".repeat(64),
        durationMs: 18_000n,
        processedAt: new Date("2026-09-01T10:10:00Z"),
      },
    });
    const payload = fix.validPayload({
      goalCreates: [
        {
          annotationId: fix.annotationId,
          title: "第 4 小节跟节拍器",
          category: "RHYTHM",
          metricType: "COUNT",
          targetValue: 10,
          unit: "次",
          dueDate: "2026-10-15",
          evidenceRequirement: "AUDIO",
        },
      ],
    });

    const response = await complete(fix, payload);
    expect(response.status, "R4: 正常关闭应返回 200").toBe(200);

    const session = await ctx.prisma.practiceSession.findUniqueOrThrow({ where: { id: fix.sessionId } });
    expect(session.status).toBe("COMPLETED");
    expect(session.version).toBe(1);
    expect(session.completedAt, "R4: completedAt 必须写入").toBeTruthy();
    expect(session.actualDurationMs, "R4: 时长必须按 READY 音频合计为 30000ms").toBe(30_000n);

    const review = await ctx.prisma.sessionReview.findUniqueOrThrow({ where: { sessionId: fix.sessionId } });
    expect(review.nextFocus, "R4: 下次重点必须落库").toContain("60bpm");
    expect(review.completedAt, "R4: 复盘必须标记完成时间").toBeTruthy();

    const newGoal = await ctx.prisma.goal.findFirstOrThrow({ where: { sourceSessionId: fix.sessionId, annotationId: fix.annotationId } });
    expect(newGoal.status, "R4: 新建目标默认 OPEN").toBe("OPEN");

    const oldGoal = await ctx.prisma.goal.findUniqueOrThrow({ where: { id: fix.openGoalId } });
    expect(oldGoal.status, "R4: 记录进度后旧目标必须推进为 IN_PROGRESS").toBe("IN_PROGRESS");
    expect(oldGoal.version, "R4: 旧目标 version 必须递增").toBe(1);
    const progress = await ctx.prisma.goalProgress.findFirstOrThrow({ where: { goalId: fix.openGoalId } });
    expect(Number(progress.actualValue), "R4: 进度值必须落库").toBe(52);
  });

  it("R5: 已 COMPLETED 的练习不能重复关闭", async () => {
    const fix = await seedReadySession(0);
    const first = await complete(fix, fix.validPayload());
    expect(first.status).toBe(200);

    // version 用最新值，状态机检查应先于乐观锁触发
    const second = await complete(fix, fix.validPayload({ version: 1 }));
    expect(second.status, "R5: 重复关闭必须返回 409").toBe(409);
    expect(second.body).toMatchObject({ error: expect.objectContaining({ code: "INVALID_SESSION_STATE" }) });
  });
});
