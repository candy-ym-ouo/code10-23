/**
 * 关键链路：上传摘要冲突（SHA-256 去重复用与确认时摘要校验）
 *
 * S3 侧以内存对象存储替身（vi.mock 提升到所有 import 之前生效），
 * 不连接真实 MinIO；HTTP 路由、Prisma 事务与状态机全部走真实代码路径。
 *
 * 业务不变量（失败时按编号定位被破坏的具体不变量）：
 *  U1 同一用户对已 READY 音频声明相同 SHA-256 时必须复用已有对象：
 *     响应 reused=true、不返回新的预签名上传 URL，新 MediaAsset 共享 objectKey。
 *  U2 复用不产生重复存储对象（对象存储中只有一个 key），两条业务关联各自独立存在。
 *  U3 SHA-256 匹配按用户隔离：另一用户的相同摘要不得被复用（必须签发新的上传 URL）。
 *  U4 摘要大小写不敏感（声明大写摘要也能命中同一条 READY 记录）。
 *  U5 声明大小超过会话总配额时被 413 拒绝，且不得创建任何 MediaAsset。
 *  U6 complete-upload 必须校验对象真实摘要：摘要不一致时返回 UPLOAD_HASH_MISMATCH，
 *     对象被删除且媒体不会进入 UPLOADED/READY。
 *  U7 complete-upload 必须校验对象大小：大小不一致返回 UPLOAD_SIZE_MISMATCH。
 *  U8 对象缺失（客户端声明上传但 S3 中不存在）返回 UPLOAD_OBJECT_MISSING。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import "./helpers/env.js";
import type { IntegrationContext } from "./helpers/harness.js";
import { createIntegrationContext } from "./helpers/harness.js";
import { apiCall, registerUser } from "./helpers/client.js";
import { seedSession, sha256Hex } from "./helpers/seed.js";
import { AppError } from "../src/lib/errors.js";

const { objectStore } = vi.hoisted(() => {
  // 进程内对象存储替身：key -> Buffer
  const objectStore = new Map<string, Buffer>();
  return { objectStore };
});

vi.mock("../src/lib/s3.js", async () => {
  const { createHash } = await import("node:crypto");
  return {
    createUploadUrl: vi.fn(async (objectKey: string) => `https://s3.example/put/${encodeURIComponent(objectKey)}`),
    createPlaybackUrl: vi.fn(async (objectKey: string) => `https://s3.example/get/${encodeURIComponent(objectKey)}`),
    // 复刻 src/lib/s3.ts verifyObject 的判定与异常：
    // 对象缺失（HEAD 404）→ UPLOAD_OBJECT_MISSING；大小不符 → UPLOAD_SIZE_MISMATCH；
    // 摘要不符 → 删除对象并抛 UPLOAD_HASH_MISMATCH。
    verifyObject: vi.fn(async (objectKey: string, expectedSize: bigint, expectedSha: string) => {
      const body = objectStore.get(objectKey);
      if (!body) throw new AppError(400, "UPLOAD_OBJECT_MISSING", "没有找到已上传的音频对象，请重新上传");
      if (BigInt(body.length) !== expectedSize) {
        throw new AppError(400, "UPLOAD_SIZE_MISMATCH", "上传文件大小与声明不一致，请重新上传");
      }
      const hash = createHash("sha256").update(body).digest("hex");
      if (hash !== expectedSha.toLowerCase()) {
        objectStore.delete(objectKey);
        throw new AppError(400, "UPLOAD_HASH_MISMATCH", "上传文件摘要与声明不一致，请重新上传");
      }
      return undefined;
    }),
    deleteObject: vi.fn(async (objectKey: string) => {
      objectStore.delete(objectKey);
    }),
    ensureBucket: vi.fn(async () => undefined),
  };
});

// 队列（Redis）在被测路径上不应真正连通；入队动作以空桩替代。
vi.mock("../src/lib/queue.js", () => ({
  enqueueProbe: vi.fn(async () => undefined),
  enqueueCleanup: vi.fn(async () => undefined),
  enqueueExport: vi.fn(async () => undefined),
  closeQueue: vi.fn(async () => undefined),
}));

const MIME = "audio/wav";
const contentA = Buffer.from("real-audio-bytes-A");
const contentB = Buffer.from("real-audio-bytes-B-but-different-length-1234567890");
// 与 contentA 等长但内容不同：用于隔离“仅摘要冲突”（大小校验必须先通过）
const contentASameLength = Buffer.from("real-audio-bytes-Z");

describe("关键链路：上传摘要冲突", () => {
  let ctx: IntegrationContext;

  beforeAll(async () => {
    ctx = await createIntegrationContext();
  });

  beforeEach(async () => {
    await ctx.resetDatabase();
    objectStore.clear();
  });

  afterAll(async () => {
    await ctx.close();
  });

  /** 直接在库中准备一条 READY 媒体（模拟 Worker 已完成探测的既有对象） */
  async function seedReadyMedia(input: {
    userId: string;
    sessionId: string;
    objectKey: string;
    sha256: string;
    sizeBytes: bigint;
    durationMs?: bigint;
    name?: string;
  }) {
    return ctx.prisma.mediaAsset.create({
      data: {
        userId: input.userId,
        sessionId: input.sessionId,
        status: "READY",
        objectKey: input.objectKey,
        originalName: input.name ?? "existing.wav",
        mimeType: MIME,
        sizeBytes: input.sizeBytes,
        sha256: input.sha256.toLowerCase(),
        durationMs: input.durationMs ?? 12_000n,
        codec: "pcm_s16le",
        sampleRate: 44_100,
        channels: 2,
        peaks: [0.1, 0.2],
        uploadedAt: new Date("2026-09-01T10:05:00Z"),
        processedAt: new Date("2026-09-01T10:06:00Z"),
      },
    });
  }

  async function requestUpload(
    accessToken: string,
    sessionId: string,
    payload: { originalName: string; mimeType: string; sizeBytes: number; sha256: string },
  ) {
    return apiCall<{
      media: { id: string; status: string; objectKey?: string };
      reused: boolean;
      uploadUrl: string | null;
      requiredHeaders: Record<string, string>;
    }>(ctx.app, {
      method: "POST",
      url: `/api/v1/sessions/${sessionId}/media/uploads`,
      accessToken,
      payload,
    });
  }

  it("U1+U2: 相同 SHA-256 复用同一对象并建立独立业务关联，不产生新对象", async () => {
    const { user, sessionId } = await registerAndCreateSession(ctx);
    const digestA = sha256Hex(contentA);
    const existingKey = `users/${user.userId}/sessions/${sessionId}/existing.wav`;
    objectStore.set(existingKey, contentA);
    const existing = await seedReadyMedia({
      userId: user.userId,
      sessionId,
      objectKey: existingKey,
      sha256: digestA,
      sizeBytes: BigInt(contentA.length),
    });

    const response = await requestUpload(user.accessToken, sessionId, {
      originalName: "again.wav",
      mimeType: MIME,
      sizeBytes: contentA.length,
      sha256: digestA,
    });

    expect(response.status, "U1: 复用请求应返回 201").toBe(201);
    expect(response.body.reused, "U1: reused 必须为 true").toBe(true);
    expect(response.body.uploadUrl, "U1: 复用不得签发新的预签名上传 URL").toBeNull();
    expect(response.body.media.status, "U1: 复用媒体必须直接为 READY").toBe("READY");

    const rows = await ctx.prisma.mediaAsset.findMany({
      where: { userId: user.userId, sha256: digestA },
      orderBy: { createdAt: "asc" },
    });
    expect(rows, "U2: 应存在两条独立的业务关联").toHaveLength(2);
    expect(rows[0]!.id, "U2: 第一条为既有媒体").toBe(existing.id);
    expect(rows[1]!.id, "U2: 第二条为新创建的业务关联").toBe(response.body.media.id);
    expect(new Set(rows.map((r) => r.objectKey)).size, "U2: 两条关联必须共享同一个 objectKey").toBe(1);
    expect(objectStore.size, "U2: 对象存储中不得出现第二个物理对象").toBe(1);
    expect(objectStore.has(existingKey), "U2: 被复用的对象仍然存在").toBe(true);
  });

  it("U3: 其他用户的相同摘要不得被复用", async () => {
    const owner = await registerAndCreateSession(ctx, "owner");
    const other = await registerAndCreateSession(ctx, "other");
    const digestA = sha256Hex(contentA);
    const ownerKey = `users/${owner.user.userId}/sessions/${owner.sessionId}/owner.wav`;
    objectStore.set(ownerKey, contentA);
    await seedReadyMedia({
      userId: owner.user.userId,
      sessionId: owner.sessionId,
      objectKey: ownerKey,
      sha256: digestA,
      sizeBytes: BigInt(contentA.length),
    });

    const response = await requestUpload(other.user.accessToken, other.sessionId, {
      originalName: "mine.wav",
      mimeType: MIME,
      sizeBytes: contentA.length,
      sha256: digestA,
    });

    expect(response.status, "U3: 新建上传应返回 201").toBe(201);
    expect(response.body.reused, "U3: 不得复用其他用户的对象").toBe(false);
    expect(response.body.uploadUrl, "U3: 必须为新对象签发上传 URL").toBeTruthy();
    expect(response.body.media.status, "U3: 新对象应为 PENDING_UPLOAD").toBe("PENDING_UPLOAD");

    const otherMedia = await ctx.prisma.mediaAsset.findUniqueOrThrow({ where: { id: response.body.media.id } });
    expect(otherMedia.objectKey, "U3: 新对象 key 必须位于其他用户的前缀下").toContain(
      `users/${other.user.userId}/`,
    );
    expect(otherMedia.objectKey, "U3: 新对象 key 不得与属主对象相同").not.toBe(ownerKey);
  });

  it("U4: 声明大写 SHA-256 也能命中复用（大小写不敏感）", async () => {
    const { user, sessionId } = await registerAndCreateSession(ctx);
    const digestA = sha256Hex(contentA);
    const key = `users/${user.userId}/sessions/${sessionId}/a.wav`;
    objectStore.set(key, contentA);
    await seedReadyMedia({
      userId: user.userId,
      sessionId,
      objectKey: key,
      sha256: digestA,
      sizeBytes: BigInt(contentA.length),
    });

    const response = await requestUpload(user.accessToken, sessionId, {
      originalName: "upper.wav",
      mimeType: MIME,
      sizeBytes: contentA.length,
      sha256: digestA.toUpperCase(),
    });
    expect(response.status, "U4: 大写摘要请求应返回 201").toBe(201);
    expect(response.body.reused, "U4: 大写摘要必须命中同一 READY 记录").toBe(true);
  });

  it("U5: 声明大小超过会话总量配额时被拒绝且不落库", async () => {
    const { user, sessionId } = await registerAndCreateSession(ctx);
    const digestA = sha256Hex(contentA);
    await seedReadyMedia({
      userId: user.userId,
      sessionId,
      objectKey: `users/${user.userId}/sessions/${sessionId}/existing.wav`,
      sha256: digestA,
      sizeBytes: BigInt(900 * 1024 * 1024), // 已有 900 MiB（单文件 < 200 MiB 上限由 Worker 侧保证，这里仅构造配额场景）
    });

    const before = await ctx.prisma.mediaAsset.count({ where: { sessionId } });
    const response = await requestUpload(user.accessToken, sessionId, {
      originalName: "too-big.wav",
      mimeType: MIME,
      sizeBytes: 200 * 1024 * 1024,
      sha256: sha256Hex(contentB),
    });

    expect(response.status, "U5: 应返回 413").toBe(413);
    expect(response.body).toMatchObject({ error: expect.objectContaining({ code: "SESSION_SIZE_LIMIT_REACHED" }) });
    const after = await ctx.prisma.mediaAsset.count({ where: { sessionId } });
    expect(after, "U5: 被拒绝的上传不得创建 MediaAsset").toBe(before);
  });

  it("U6: 确认上传时真实摘要不一致 → UPLOAD_HASH_MISMATCH，对象删除且媒体不就绪", async () => {
    const { user, sessionId } = await registerAndCreateSession(ctx);
    const claimedDigest = sha256Hex(contentA);
    // 声明内容 A，但对象存储里实际放的是内容 B
    const create = await requestUpload(user.accessToken, sessionId, {
      originalName: "lying.wav",
      mimeType: MIME,
      sizeBytes: contentA.length,
      sha256: claimedDigest,
    });
    expect(create.status).toBe(201);
    const mediaId = create.body.media.id;
    const pending = await ctx.prisma.mediaAsset.findUniqueOrThrow({ where: { id: mediaId } });
    objectStore.set(pending.objectKey, contentASameLength);

    const complete = await apiCall<{ error?: { code: string } }>(ctx.app, {
      method: "POST",
      url: `/api/v1/media/${mediaId}/complete-upload`,
      accessToken: user.accessToken,
    });

    expect(complete.status, "U6: 摘要不一致应返回 400").toBe(400);
    expect(complete.body).toMatchObject({ error: expect.objectContaining({ code: "UPLOAD_HASH_MISMATCH" }) });
    expect(objectStore.has(pending.objectKey), "U6: 摘要不一致的对象必须被删除").toBe(false);
    const reloaded = await ctx.prisma.mediaAsset.findUniqueOrThrow({ where: { id: mediaId } });
    expect(reloaded.status, "U6: 媒体必须保持 PENDING_UPLOAD，不得进入已上传/就绪状态").toBe("PENDING_UPLOAD");
  });

  it("U7: 确认上传时大小不一致 → UPLOAD_SIZE_MISMATCH", async () => {
    const { user, sessionId } = await registerAndCreateSession(ctx);
    const create = await requestUpload(user.accessToken, sessionId, {
      originalName: "wrong-size.wav",
      mimeType: MIME,
      sizeBytes: contentA.length,
      sha256: sha256Hex(contentA),
    });
    const pending = await ctx.prisma.mediaAsset.findUniqueOrThrow({ where: { id: create.body.media.id } });
    objectStore.set(pending.objectKey, contentB);

    const complete = await apiCall<{ error?: { code: string } }>(ctx.app, {
      method: "POST",
      url: `/api/v1/media/${create.body.media.id}/complete-upload`,
      accessToken: user.accessToken,
    });
    expect(complete.status, "U7: 大小不一致应返回 400").toBe(400);
    expect(complete.body).toMatchObject({ error: expect.objectContaining({ code: "UPLOAD_SIZE_MISMATCH" }) });
  });

  it("U8: 对象未真正上传 → UPLOAD_OBJECT_MISSING", async () => {
    const { user, sessionId } = await registerAndCreateSession(ctx);
    const create = await requestUpload(user.accessToken, sessionId, {
      originalName: "ghost.wav",
      mimeType: MIME,
      sizeBytes: contentA.length,
      sha256: sha256Hex(contentA),
    });
    // 故意不向 objectStore 写入任何内容
    const complete = await apiCall<{ error?: { code: string } }>(ctx.app, {
      method: "POST",
      url: `/api/v1/media/${create.body.media.id}/complete-upload`,
      accessToken: user.accessToken,
    });
    expect(complete.status, "U8: 缺失对象应返回 400").toBe(400);
    expect(complete.body).toMatchObject({ error: expect.objectContaining({ code: "UPLOAD_OBJECT_MISSING" }) });
  });
});

async function registerAndCreateSession(
  ctx: IntegrationContext,
  suffix?: string,
): Promise<{ user: { userId: string; accessToken: string }; sessionId: string }> {
  const user = await registerUser(ctx.app, suffix);
  const session = await seedSession(ctx.prisma, { userId: user.userId });
  return { user, sessionId: session.id };
}
