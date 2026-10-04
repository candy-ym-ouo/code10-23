import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

vi.mock("../src/lib/s3.js", () => ({
  ensureBucket: vi.fn(),
  createUploadUrl: vi.fn(),
  createPlaybackUrl: vi.fn(),
  verifyObject: vi.fn(),
  deleteObject: vi.fn(),
}));
vi.mock("../src/lib/queue.js", () => ({
  enqueueProbe: vi.fn(),
  enqueueCleanup: vi.fn(),
  enqueueExport: vi.fn(),
  closeQueue: vi.fn(),
}));

import { buildApp } from "../src/app.js";
import { prisma } from "../src/lib/prisma.js";
import {
  makeRequester,
  registerUser,
  testSha256,
  type AuthenticatedRequest,
} from "./helpers/integration.js";

/**
 * 构造一条可提交复盘的练习：READY 音频 + 标记 + 一个已有 OPEN 目标。
 * 完成该练习时必须为已有目标带一条进度更新（describeMissingReview 不变量）。
 */
async function seedCompletableSession(userId: string, opts: { withOpenGoal?: boolean } = {}) {
    const startedAt = new Date(Date.now() - 30 * 60_000);
    const session = await prisma.practiceSession.create({
      data: {
        userId,
        title: "复盘回滚练习",
        instrument: "Violin",
        startedAt,
        status: "IN_REVIEW",
        actualDurationMs: 900_000n,
      },
    });
    const media = await prisma.mediaAsset.create({
      data: {
        userId,
        sessionId: session.id,
        status: "READY",
        objectKey: `users/${userId}/sessions/${session.id}/ready.wav`,
        originalName: "ready.wav",
        mimeType: "audio/wav",
        sizeBytes: 8192n,
        sha256: testSha256(`media-${session.id}`),
        durationMs: 900_000n,
        sampleRate: 44_100,
        channels: 2,
        processedAt: new Date(),
      },
    });
    const annotation = await prisma.annotation.create({
      data: {
        userId,
        sessionId: session.id,
        mediaId: media.id,
        type: "RHYTHM",
        severity: 3,
        startMs: 1000n,
        endMs: 3000n,
        title: "节拍漂移",
      },
    });
    let goalId: string | undefined;
    if (opts.withOpenGoal !== false) {
      const goal = await prisma.goal.create({
        data: {
          userId,
          sourceSessionId: session.id,
          title: "节拍器 60bpm 稳定演奏",
          category: "RHYTHM",
          metricType: "SPEED",
          targetValue: "60",
          unit: "bpm",
          dueDate: new Date(Date.now() + 7 * 86_400_000),
          evidenceRequirement: "NONE",
          status: "OPEN",
        },
      });
      goalId = goal.id;
    }
    return { sessionId: session.id, mediaId: media.id, annotationId: annotation.id, goalId };
}

const completionBody = (version: number, goalId?: string) => ({
  version,
  review: {
    goodPoints: "长音更稳了",
    mainIssues: "弱起小节抢拍",
    nextFocus: "跟节拍器从 50bpm 分段慢练",
    noIssues: false,
  },
  goalCreates: [],
  goalProgressUpdates: goalId
    ? [{ goalId, actualValue: 52, note: "能稳定跟上 52bpm", recordedAt: new Date().toISOString() }]
    : [],
});

describe("关键链路：复盘关闭事务回滚", () => {
  let app: FastifyInstance;
  let request: AuthenticatedRequest;
  let userId: string;

  beforeAll(async () => {
    app = await buildApp();
    const user = await registerUser(app);
    userId = user.userId;
    request = makeRequester(app, { accessToken: user.accessToken });
  });

  afterAll(async () => {
    await app.close();
  });

  it("合法提交在单事务内关闭复盘、写进度并推进目标", async () => {
    const { sessionId, goalId } = await seedCompletableSession(userId);
    const before = await prisma.practiceSession.findUniqueOrThrow({ where: { id: sessionId } });

    const response = await request({
      method: "POST",
      url: `/api/v1/sessions/${sessionId}/complete`,
      body: completionBody(before.version, goalId),
    });
    expect(response.statusCode, `复盘应成功关闭，实际: ${JSON.stringify(response.body)}`).toBe(200);

    const session = await prisma.practiceSession.findUniqueOrThrow({ where: { id: sessionId }, include: { review: true } });
    expect(session.status, "练习必须迁移到 COMPLETED").toBe("COMPLETED");
    expect(session.version, "成功提交恰好推进一个版本").toBe(before.version + 1);
    expect(session.completedAt, "必须记录完成时间").toBeTruthy();
    expect(session.review?.completedAt, "复盘必须随事务写入完成时间").toBeTruthy();

    const progresses = await prisma.goalProgress.findMany({ where: { sessionId, goalId } });
    expect(progresses, "必须写入一条目标进度").toHaveLength(1);
    const goal = await prisma.goal.findUniqueOrThrow({ where: { id: goalId } });
    expect(goal.status, "有进度后目标必须推进到 IN_PROGRESS").toBe("IN_PROGRESS");
    expect(goal.version, "目标版本应随状态推进").toBe(1);
  });

  /**
   * 核心不变量：复盘关闭是“全有或全无”。
   * 人为让事务内的 goalProgress.create 失败（位于会话状态更新与复盘 upsert 之后），
   * 则此前写入的状态、completedAt、复盘全部必须回滚。
   */
  it("事务中途失败时整体回滚，练习/复盘/目标均保持提交前状态", async () => {
    const { sessionId, goalId } = await seedCompletableSession(userId);
    const before = await prisma.practiceSession.findUniqueOrThrow({ where: { id: sessionId }, include: { review: true } });
    expect(before.review, "前置条件：提交前不存在复盘记录").toBeNull();

    // 包装应用共享的 prisma 单例：仅让本事务内的 goalProgress.create 失败一次。
    // 必须在安装 spy 之前拿到原型上的原始实现，否则 bind 会重新命中 spy 自身。
    const originalTransaction = prisma.$transaction;
    const transactionSpy = vi.spyOn(prisma, "$transaction");
    const wrapTx = (tx: any): any =>
      new Proxy(tx, {
        get(target, prop) {
          if (prop === "goalProgress") {
            return new Proxy(target.goalProgress, {
              get(delegate, method) {
                if (method === "create") {
                  return async () => {
                    throw new Error("FORCED_PROGRESS_WRITE_FAILURE");
                  };
                }
                const value = (delegate as any)[method];
                return typeof value === "function" ? value.bind(delegate) : value;
              },
            });
          }
          const value = (target as any)[prop];
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    transactionSpy.mockImplementation((async (arg: unknown) => {
      if (typeof arg === "function") {
        return originalTransaction.call(prisma, (async (tx: unknown) => arg(wrapTx(tx as object))) as never);
      }
      return originalTransaction.call(prisma, arg as never);
    }) as typeof prisma.$transaction);

    let statusCode = 0;
    try {
      const response = await request({
        method: "POST",
        url: `/api/v1/sessions/${sessionId}/complete`,
        body: completionBody(before.version, goalId),
      });
      statusCode = response.statusCode;
    } finally {
      transactionSpy.mockRestore();
    }
    expect(statusCode, "事务内写进度失败必须表现为 500，而不是部分成功的 200").toBe(500);

    // —— 逐条不变量定位回滚是否彻底 ——
    const after = await prisma.practiceSession.findUniqueOrThrow({ where: { id: sessionId }, include: { review: true } });
    expect(after.status, "回滚后练习必须仍是 IN_REVIEW").toBe("IN_REVIEW");
    expect(after.version, "回滚后版本号不得增加").toBe(before.version);
    expect(after.completedAt, "回滚后不得残留 completedAt").toBeNull();
    expect(after.review, "回滚后不得残留复盘记录").toBeNull();

    const progressCount = await prisma.goalProgress.count({ where: { sessionId, goalId } });
    expect(progressCount, "失败的进度写入必须回滚").toBe(0);
    const goal = await prisma.goal.findUniqueOrThrow({ where: { id: goalId } });
    expect(goal.status, "目标不得被半途推进").toBe("OPEN");
    expect(goal.version, "目标版本必须保持 0").toBe(0);

    // 回滚后原练习仍可使用同一版本号重新提交（没有留下半开状态）。
    const retry = await request({
      method: "POST",
      url: `/api/v1/sessions/${sessionId}/complete`,
      body: completionBody(before.version, goalId),
    });
    expect(retry.statusCode, `回滚后应允许重新提交，实际: ${JSON.stringify(retry.body)}`).toBe(200);
  });

  it("乐观版本号过期时返回 VERSION_CONFLICT 且不产生任何变更", async () => {
    const { sessionId, goalId } = await seedCompletableSession(userId);
    const before = await prisma.practiceSession.findUniqueOrThrow({ where: { id: sessionId } });

    // 模拟并发：另一个窗口先把版本号推进到 1，本请求仍携带版本 0 提交。
    const bumped = await prisma.practiceSession.updateMany({
      where: { id: sessionId, version: before.version },
      data: { version: { increment: 1 } },
    });
    expect(bumped.count).toBe(1);

    const response = await request({
      method: "POST",
      url: `/api/v1/sessions/${sessionId}/complete`,
      body: completionBody(before.version, goalId),
    });
    expect(response.statusCode).toBe(409);
    expect((response.body as { error: { code: string } }).error.code).toBe("VERSION_CONFLICT");

    const after = await prisma.practiceSession.findUniqueOrThrow({ where: { id: sessionId }, include: { review: true } });
    expect(after.status).toBe("IN_REVIEW");
    expect(after.version, "冲突提交不得推进版本").toBe(before.version + 1);
    expect(after.review, "冲突提交不得写入复盘").toBeNull();
    expect(await prisma.goalProgress.count({ where: { sessionId } })).toBe(0);
  });
});
