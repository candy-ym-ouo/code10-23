import type { PrismaClient } from "@prisma/client";
import { createHash, randomUUID } from "node:crypto";

/** 生成确定性内容的 SHA-256 十六进制摘要 */
export function sha256Hex(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

interface SessionSeed {
  userId: string;
  title?: string;
  instrument?: string;
  status?: "DRAFT" | "IN_REVIEW" | "COMPLETED" | "ARCHIVED" | "DELETING" | "DELETE_FAILED";
  startedAt?: Date;
  actualDurationMs?: bigint;
  version?: number;
  completedAt?: Date | null;
}

/** 绕过 HTTP 直接创建练习记录，用于精确构造前置状态 */
export async function seedSession(prisma: PrismaClient, input: SessionSeed) {
  return prisma.practiceSession.create({
    data: {
      userId: input.userId,
      title: input.title ?? "种子练习",
      instrument: input.instrument ?? "Piano",
      status: input.status ?? "DRAFT",
      startedAt: input.startedAt ?? new Date("2026-09-01T10:00:00Z"),
      actualDurationMs: input.actualDurationMs ?? 0n,
      version: input.version ?? 0,
      completedAt: input.completedAt ?? null,
    },
  });
}

/** 生成一个可安全作为邮箱后缀的唯一标识 */
export function uniqueSuffix(): string {
  return randomUUID();
}
