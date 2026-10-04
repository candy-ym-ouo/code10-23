import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";

export interface RegisterResult {
  userId: string;
  email: string;
  accessToken: string;
  /** 注册接口下发的原始刷新令牌（来自 Set-Cookie） */
  refreshToken: string;
}

export interface ApiResponse<T = unknown> {
  status: number;
  body: T;
  cookies: Record<string, string>;
}

interface InjectedCookie {
  name: string;
  value: string;
}

export function parseCookies(rawCookies: unknown): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const cookie of (rawCookies ?? []) as InjectedCookie[]) {
    cookies[cookie.name] = cookie.value;
  }
  return cookies;
}

/** 注册一个全新用户，返回其身份令牌与首个刷新令牌，便于各用例自造数据。 */
export async function registerUser(app: FastifyInstance, suffix = randomUUID()): Promise<RegisterResult> {
  const email = `it-${suffix}@example.com`;
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    payload: { email, password: "CorrectHorse10", displayName: "集成测试用户" },
  });
  if (response.statusCode !== 201) {
    throw new Error(`registerUser 失败: ${response.statusCode} ${response.body}`);
  }
  const body = response.json<{ user: { id: string; email: string }; accessToken: string }>();
  const cookies = parseCookies(response.cookies);
  return {
    userId: body.user.id,
    email: body.user.email,
    accessToken: body.accessToken,
    refreshToken: cookies["practice_refresh"]!,
  };
}

interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  url: string;
  payload?: unknown;
  query?: Record<string, unknown>;
  accessToken?: string;
  cookies?: Record<string, string>;
}

export async function apiCall<T = unknown>(app: FastifyInstance, options: RequestOptions): Promise<ApiResponse<T>> {
  const response = await app.inject({
    method: options.method ?? "GET",
    url: options.url,
    query: options.query,
    payload: options.payload,
    headers: {
      ...(options.accessToken ? { authorization: `Bearer ${options.accessToken}` } : {}),
      ...(options.cookies
        ? { cookie: Object.entries(options.cookies).map(([key, value]) => `${key}=${value}`).join("; ") }
        : {}),
      ...(options.payload !== undefined ? { "content-type": "application/json" } : {}),
    },
  });
  const parsed = response.body ? (JSON.parse(response.body) as T) : (undefined as T);
  return {
    status: response.statusCode,
    body: parsed,
    cookies: parseCookies(response.cookies),
  };
}

/** 直接调用刷新接口，可显式携带任意（可能已被重放的）原始令牌。 */
export function refreshWith(app: FastifyInstance, rawToken: string) {
  return apiCall<{ accessToken: string; userId: string; refreshed: boolean }>(app, {
    method: "POST",
    url: "/api/v1/auth/refresh",
    cookies: { practice_refresh: rawToken },
  });
}
