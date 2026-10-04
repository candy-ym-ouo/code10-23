import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

// vi.mock 会被提升到所有 import 之前；这些外部基础设施在认证链路中不应被触达。
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
import { hashRefreshToken } from "../src/lib/security.js";
import { makeRequester, registerUser } from "./helpers/integration.js";

describe("关键链路：刷新令牌轮换与重放检测", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
  });

  afterAll(async () => {
    await app.close();
  });

  /**
   * 不变量（README「数据与安全」第 2 条）：
   * Refresh Token 每次轮换；被吊销令牌再次使用（重放）必须撤销同一会话族，
   * 包括由该令牌刚轮换出来的新令牌。
   */
  it("重放已轮换的旧令牌时撤销整个会话族（含刚签发的新令牌）", async () => {
    const user = await registerUser(app);
    const request = makeRequester(app, { refreshToken: user.refreshToken });

    // 1) 正常轮换：旧令牌被吊销、replacedBy 指向新令牌，并下发新 Cookie。
    const first = await request({ method: "POST", url: "/api/v1/auth/refresh" });
    expect(first.statusCode, `首次轮换应成功，实际: ${JSON.stringify(first.body)}`).toBe(200);
    const rotatedCookie = String(first.headers["set-cookie"] ?? "");
    const rotatedMatch = /practice_refresh=([^;]+)/.exec(rotatedCookie);
    expect(rotatedMatch, "轮换响应必须下发新的 refresh Cookie").toBeTruthy();
    const rotatedToken = rotatedMatch![1]!;

    const sessionsAfterRotation = await prisma.refreshSession.findMany({
      where: { userId: user.userId },
      orderBy: { createdAt: "asc" },
    });
    expect(sessionsAfterRotation).toHaveLength(2);
    const familyId = sessionsAfterRotation[0]!.familyId;
    for (const session of sessionsAfterRotation) {
      expect(session.familyId, "同一登录轮换链必须共享 familyId").toBe(familyId);
    }
    const oldRow = sessionsAfterRotation.find((row) => row.tokenHash === hashRefreshToken(user.refreshToken))!;
    const newRow = sessionsAfterRotation.find((row) => row.tokenHash === hashRefreshToken(rotatedToken))!;
    expect(oldRow.revokedAt, "旧令牌轮换后必须立即吊销").toBeTruthy();
    expect(oldRow.replacedBy, "旧令牌必须记录被哪条会话替换").toBe(newRow.id);
    expect(newRow.revokedAt, "新令牌轮换后应保持可用").toBeNull();

    // 2) 攻击者重放旧令牌。
    const replay = await makeRequester(app, { refreshToken: user.refreshToken })({
      method: "POST",
      url: "/api/v1/auth/refresh",
    });
    expect(replay.statusCode, "重放必须被拒绝").toBe(401);
    expect((replay.body as { error: { code: string } }).error.code).toBe("AUTH_REQUIRED");
    expect(String(replay.headers["set-cookie"] ?? ""), "检测到复用时必须清除浏览器 Cookie").toMatch(/practice_refresh=;|practice_refresh=Max-Age=0|practice_refresh=[^;]*;\s*Max-Age=0/);

    // 3) 核心不变量：族内所有未吊销会话（含刚签发的新令牌）全部失效。
    const familySessions = await prisma.refreshSession.findMany({ where: { familyId } });
    expect(familySessions, "族内应恰好有两条会话记录").toHaveLength(2);
    for (const session of familySessions) {
      expect(session.revokedAt, `会话 ${session.id} 在检测到重放后必须被吊销`).toBeTruthy();
    }

    // 4) 被“连带撤销”的新令牌再使用时也不能复活，且不产生新会话。
    const useRevolved = await makeRequester(app, { refreshToken: rotatedToken })({
      method: "POST",
      url: "/api/v1/auth/refresh",
    });
    expect(useRevolved.statusCode).toBe(401);
    const finalCount = await prisma.refreshSession.count({ where: { familyId } });
    expect(finalCount, "重放路径不得新建任何会话").toBe(2);
  });

  it("未知刷新令牌被拒绝且不影响既有会话", async () => {
    const user = await registerUser(app);
    const unknown = "totally-made-up-token-not-in-database-xxxxxxxx";
    const response = await makeRequester(app, { refreshToken: unknown })({
      method: "POST",
      url: "/api/v1/auth/refresh",
    });
    expect(response.statusCode).toBe(401);
    const intact = await prisma.refreshSession.findFirst({ where: { tokenHash: hashRefreshToken(user.refreshToken) } });
    expect(intact?.revokedAt, "未命中的令牌不应吊销任何真实会话").toBeNull();
  });
});
