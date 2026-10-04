/**
 * 关键链路集成测试共享夹具（造数 + HTTP 助手）。
 *
 * 数据库由 vitest globalSetup（test/global-database.ts）启动的单个嵌入式
 * PostgreSQL 提供，schema 来自真实迁移；每个测试文件开始前由 setup-env.ts
 * 清空全部业务表，因此文件之间完全隔离。应用内的 prisma 单例与测试断言
 * 使用同一连接，测试读到的就是生产代码写入的口径。
 */
import { createHash } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import type { HTTPMethods } from "fastify";
import type { FastifyInstance } from "fastify";

export function testSha256(label: string): string {
  return createHash("sha256").update(label).digest("hex");
}

export async function createUser(
  prisma: PrismaClient,
  overrides: { email?: string; passwordHash?: string } = {},
) {
  return prisma.user.create({
    data: {
      email: overrides.email ?? `user-${Math.random().toString(36).slice(2)}@example.test`,
      displayName: "测试用户",
      passwordHash: overrides.passwordHash ?? "stub-password-hash",
    },
  });
}

export interface RegisteredClient {
  userId: string;
  email: string;
  accessToken: string;
  /** 最新一次注册/刷新下发的原始 refresh token（来自 Set-Cookie）。 */
  refreshToken: string;
}

export interface ApiResponse<T = unknown> {
  statusCode: number;
  body: T;
  headers: Record<string, unknown>;
}

export type AuthenticatedRequest = (options: {
  method: HTTPMethods;
  url: string;
  body?: unknown;
  headers?: Record<string, string>;
  cookies?: Record<string, string>;
}) => Promise<ApiResponse>;

const VALID_PASSWORD = "Test12345Pass";

function readRefreshCookie(setCookie: string[] | string | undefined): string | undefined {
  const header = Array.isArray(setCookie) ? setCookie.join(",") : (setCookie ?? "");
  const match = /practice_refresh=([^;]+)/.exec(header);
  return match?.[1];
}

/**
 * 走真实的 /auth/register 链路注册用户，得到 access token、refresh cookie，
 * 保证测试起点与生产请求路径一致。后续请求请配合 makeRequester 使用。
 */
export async function registerUser(app: FastifyInstance, email?: string): Promise<RegisteredClient> {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    payload: {
      email: email ?? `${Math.random().toString(36).slice(2)}@example.test`,
      password: VALID_PASSWORD,
      displayName: "测试用户",
    },
  });
  if (response.statusCode !== 201) {
    throw new Error(`注册夹具失败: ${response.statusCode} ${response.body}`);
  }
  const body = response.json<{ user: { id: string; email: string }; accessToken: string }>();
  const refreshToken = readRefreshCookie(response.headers["set-cookie"] as string[] | undefined);
  if (!refreshToken) throw new Error("注册响应缺少 practice_refresh Cookie");
  return { userId: body.user.id, email: body.user.email, accessToken: body.accessToken, refreshToken };
}

export function makeRequester(
  app: FastifyInstance,
  auth: { accessToken?: string; refreshToken?: string },
): AuthenticatedRequest {
  return async ({ method, url, body, headers, cookies }) => {
    const cookieEntries = { ...(auth.refreshToken ? { practice_refresh: auth.refreshToken } : {}), ...cookies };
    const requestHeaders = {
      ...(auth.accessToken ? { authorization: `Bearer ${auth.accessToken}` } : {}),
      ...(Object.keys(cookieEntries).length
        ? { cookie: Object.entries(cookieEntries).map(([key, value]) => `${key}=${value}`).join("; ") }
        : {}),
      ...headers,
    };
    // 这里仅做测试层 HTTP 包装：payload/响应按 light-my-request 约定处理，
    // 显式 any 让两个重载分支合并，不影响业务类型安全。
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const response: any = body === undefined
      ? await app.inject({ method: method as "GET", url, headers: requestHeaders })
      : await app.inject({ method: method as "POST", url, payload: body as never, headers: requestHeaders });
    let parsed: unknown;
    if (response.body === "") {
      parsed = null;
    } else {
      try {
        parsed = response.json();
      } catch {
        parsed = response.body;
      }
    }
    return { statusCode: response.statusCode, body: parsed, headers: response.headers as unknown as Record<string, unknown> };
  };
}
