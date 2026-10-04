/**
 * 关键链路：刷新令牌重放（Refresh Token Replay / Rotation）
 *
 * 业务不变量（失败时按断言顺序定位被破坏的具体不变量）：
 *  I1 正常轮换后，旧令牌立即撤销（revokedAt 非空），新令牌可用且属于同一会话族。
 *  每次轮换恰好产生一条新的 refresh_sessions，且 replacedBy 指向下一条。
 *  I3 已撤销旧令牌被再次使用（重放）时，接口返回 401 AUTH_REQUIRED，
 *     并且同一家族内所有尚未撤销的会话被级联撤销（族吊销）。
 *  I4 族吊销必须波及“重放之后合法客户端刚轮换出的新令牌”，防止攻击者旧令牌继续可用。
 *  I5 其他用户的会话族不受牵连。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import "./helpers/env.js";
import type { IntegrationContext } from "./helpers/harness.js";
import { createIntegrationContext } from "./helpers/harness.js";
import { apiCall, refreshWith, registerUser } from "./helpers/client.js";
import { REFRESH_COOKIE } from "../src/services/auth-service.js";

describe("关键链路：刷新令牌重放检测", () => {
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

  it("旧令牌二次使用会吊销整个会话族，且不波及其他用户", async () => {
    const victim = await registerUser(ctx.app, "victim");
    const bystander = await registerUser(ctx.app, "bystander");

    // ---- 合法客户端正常完成一次轮换 ----
    const firstRotation = await refreshWith(ctx.app, victim.refreshToken);
    expect(firstRotation.status, "I1: 正常轮换应返回 200").toBe(200);
    const secondToken = firstRotation.cookies[REFRESH_COOKIE];
    expect(secondToken, "I1: 轮换响应必须下发新的刷新 Cookie").toBeTruthy();

    const sessionsAfterRotation = await ctx.prisma.refreshSession.findMany({
      where: { userId: victim.userId },
      orderBy: { createdAt: "asc" },
    });
    expect(sessionsAfterRotation, "I2: 注册 1 条 + 轮换 1 条 = 2 条会话").toHaveLength(2);
    const [first, second] = sessionsAfterRotation as [
      (typeof sessionsAfterRotation)[number],
      (typeof sessionsAfterRotation)[number],
    ];
    expect(first.familyId, "I1: 新旧令牌必须属于同一会话族").toBe(second.familyId);
    expect(first.revokedAt, "I1: 旧令牌轮换后必须立即撤销").toBeTruthy();
    expect(second.revokedAt, "I1: 新令牌轮换后必须保持可用").toBeNull();
    expect(first.replacedBy, "I2: 旧令牌必须通过 replacedBy 指向后继").toBe(second.id);
    expect(second.replacedBy, "I2: 最新令牌没有后继").toBeNull();

    // ---- 攻击者抢在合法客户端之前重放旧令牌 ----
    const replay = await refreshWith(ctx.app, victim.refreshToken);
    expect(replay.status, "I3: 重放必须被拒绝").toBe(401);
    expect(replay.body, "I3: 重放必须返回 AUTH_REQUIRED 错误码").toMatchObject({
      error: expect.objectContaining({ code: "AUTH_REQUIRED" }),
    });

    const familyAfterReplay = await ctx.prisma.refreshSession.findMany({
      where: { familyId: first.familyId },
      orderBy: { createdAt: "asc" },
    });
    expect(familyAfterReplay, "I3: 重放请求不得创建新会话").toHaveLength(2);
    expect(
      familyAfterReplay.every((session) => session.revokedAt !== null),
      "I3: 检测到重放后，同一家族的所有会话必须全部撤销",
    ).toBe(true);

    // ---- 合法客户端手里的新令牌此时也必须已经失效 ----
    const legitUseAfterReplay = await refreshWith(ctx.app, secondToken!);
    expect(legitUseAfterReplay.status, "I4: 族吊销后合法新令牌也必须被拒绝").toBe(401);
    const sessionsAfterLegitRetry = await ctx.prisma.refreshSession.count({
      where: { familyId: first.familyId },
    });
    expect(sessionsAfterLegitRetry, "I4: 对已吊销族的请求不得创建新会话").toBe(2);

    // ---- 另一用户的会话族不受影响 ----
    const bystanderRotation = await refreshWith(ctx.app, bystander.refreshToken);
    expect(bystanderRotation.status, "I5: 其他用户的刷新令牌不应被牵连").toBe(200);
    const bystanderActive = await ctx.prisma.refreshSession.count({
      where: { userId: bystander.userId, revokedAt: null },
    });
    expect(bystanderActive, "I5: 其他用户家族中应保留 1 条可用会话").toBe(1);
  });

  it("从未签发过的伪造令牌无法换取访问令牌", async () => {
    await registerUser(ctx.app, "forged");
    const forged = Buffer.from("never-issued-token-attack").toString("base64url");
    const response = await refreshWith(ctx.app, forged);
    expect(response.status, "未知令牌必须返回 401").toBe(401);
    expect(response.body).toMatchObject({ error: expect.objectContaining({ code: "AUTH_REQUIRED" }) });

    const me = await apiCall(ctx.app, {
      method: "GET",
      url: "/api/v1/sessions?limit=1",
      accessToken: "definitely-not-a-jwt",
    });
    expect(me.status, "无有效访问令牌必须被认证拦截").toBe(401);
  });
});
