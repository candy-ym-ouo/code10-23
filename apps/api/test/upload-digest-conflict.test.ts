import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

// 上传链路只需 S3 签名/校验与队列入队，全部打桩；数据库与应用逻辑保持真实。
const s3Mocks = vi.hoisted(() => ({
  verifyObject: vi.fn(),
  createUploadUrl: vi.fn(),
  deleteObject: vi.fn(),
  createPlaybackUrl: vi.fn(),
}));
vi.mock("../src/lib/s3.js", () => ({
  ensureBucket: vi.fn(),
  createUploadUrl: s3Mocks.createUploadUrl,
  createPlaybackUrl: s3Mocks.createPlaybackUrl,
  verifyObject: s3Mocks.verifyObject,
  deleteObject: s3Mocks.deleteObject,
}));
vi.mock("../src/lib/queue.js", () => ({
  enqueueProbe: vi.fn(),
  enqueueCleanup: vi.fn(),
  enqueueExport: vi.fn(),
  closeQueue: vi.fn(),
}));

import { buildApp } from "../src/app.js";
import { prisma } from "../src/lib/prisma.js";
import type { MediaStatus } from "@prisma/client";
import { AppError } from "../src/lib/errors.js";
import {
  makeRequester,
  registerUser,
  testSha256,
  type AuthenticatedRequest,
} from "./helpers/integration.js";

async function createDraftSession(userId: string) {
  return prisma.practiceSession.create({
    data: {
      userId,
      title: "上传冲突测试练习",
      instrument: "Piano",
      startedAt: new Date(),
      status: "DRAFT",
    },
  });
}

const uploadPayload = (overrides: Record<string, unknown> = {}) => ({
  originalName: "take.wav",
  mimeType: "audio/wav",
  sizeBytes: "4096",
  sha256: testSha256("same-content"),
  ...overrides,
});

describe("关键链路：上传摘要冲突与对象复用", () => {
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

  beforeEach(() => {
    s3Mocks.verifyObject.mockReset();
    s3Mocks.createUploadUrl.mockReset();
    s3Mocks.deleteObject.mockReset();
  });

  /**
   * 不变量（README「数据与安全」第 4 条）：
   * 同一用户重复上传相同 SHA-256 时复用已有对象，新练习只建业务关联，
   * 不新建对象键、不进入上传/探测队列。
   */
  it("相同 SHA-256 再次上传时复用已有 READY 对象且不产生预签名地址", async () => {
    const firstSession = await createDraftSession(userId);
    const secondSession = await createDraftSession(userId);
    const digest = testSha256("reused-content");
    const sharedObjectKey = `users/${userId}/objects/original-${digest.slice(0, 12)}`;

    // 模拟 Worker 已处理完一段音频。
    await prisma.mediaAsset.create({
      data: {
        userId,
        sessionId: firstSession.id,
        status: "READY",
        objectKey: sharedObjectKey,
        originalName: "first.wav",
        mimeType: "audio/wav",
        sizeBytes: 4096n,
        sha256: digest,
        durationMs: 12_000n,
        codec: "pcm_s16le",
        sampleRate: 44_100,
        channels: 2,
        uploadedAt: new Date(),
        processedAt: new Date(),
      },
    });

    const response = await request({
      method: "POST",
      url: `/api/v1/sessions/${secondSession.id}/media/uploads`,
      body: uploadPayload({ sha256: digest }),
    });
    expect(response.statusCode, `摘要复用应直接 201，实际: ${JSON.stringify(response.body)}`).toBe(201);
    const body = response.body as {
      reused: boolean;
      uploadUrl: string | null;
      media: { id: string; status: MediaStatus };
    };
    expect(body.reused, "必须显式标记对象复用").toBe(true);
    expect(body.uploadUrl, "复用时不得签发新的上传地址").toBeNull();
    expect(body.media.status).toBe("READY");

    // 数据库不变量：两条 MediaAsset 指向同一对象键，且没有产生 PENDING_UPLOAD 记录。
    const assets = await prisma.mediaAsset.findMany({
      where: { sha256: digest, userId },
      orderBy: { createdAt: "asc" },
    });
    expect(assets).toHaveLength(2);
    expect(assets[0]!.sessionId).toBe(firstSession.id);
    expect(assets[1]!.sessionId).toBe(secondSession.id);
    for (const asset of assets) {
      expect(asset.objectKey, "重复上传必须复用同一对象键").toBe(sharedObjectKey);
      expect(asset.status, "复用资产应直接 READY").toBe("READY");
      expect(asset.processedAt, "复用资产沿用已处理时间").toBeTruthy();
    }
    const distinctKeys = new Set(assets.map((asset) => asset.objectKey));
    expect(distinctKeys.size, "相同摘要只能对应一个存储对象").toBe(1);

    expect(s3Mocks.createUploadUrl, "复用路径不允许生成 S3 预签名 URL").not.toHaveBeenCalled();
  });

  /**
   * 不变量：完成上传时对象真实摘要必须等于声明摘要。
   * 不一致要拒绝（UPLOAD_HASH_MISMATCH）、删除可疑对象，
   * 且 MediaAsset 不得停留在“已上传/已就绪”的可完成复盘状态。
   */
  it("确认上传时真实对象摘要与声明不符则拒绝并保持失败态", async () => {
    const session = await createDraftSession(userId);
    const declaredDigest = testSha256("declared");
    const objectKey = `users/${userId}/sessions/${session.id}/pending-asset`;
    const asset = await prisma.mediaAsset.create({
      data: {
        userId,
        sessionId: session.id,
        status: "PENDING_UPLOAD",
        objectKey,
        originalName: "take.wav",
        mimeType: "audio/wav",
        sizeBytes: 4096n,
        sha256: declaredDigest,
        expiresAt: new Date(Date.now() + 60 * 60_000),
      },
    });
    s3Mocks.verifyObject.mockRejectedValue(new AppError(400, "UPLOAD_HASH_MISMATCH", "上传文件摘要与声明不一致，请重新上传"));

    const response = await request({ method: "POST", url: `/api/v1/media/${asset.id}/complete-upload` });
    expect(response.statusCode, "摘要不一致必须返回 400").toBe(400);
    expect((response.body as { error: { code: string } }).error.code).toBe("UPLOAD_HASH_MISMATCH");

    const persisted = await prisma.mediaAsset.findUniqueOrThrow({ where: { id: asset.id } });
    expect(["PENDING_UPLOAD", "FAILED"], `资产不得被错误标记为 UPLOADED/READY，实际: ${persisted.status}`).toContain(persisted.status);
    expect(persisted.sha256, "声明摘要必须原样保留以便排查").toBe(declaredDigest);
    expect(persisted.uploadedAt, "摘要校验失败不得写入 uploadedAt").toBeNull();

    // 仍处于 PENDING_UPLOAD 的会话不能进入复盘闭环（媒体不变量联动）。
    const review = await request({ method: "POST", url: `/api/v1/sessions/${session.id}/start-review` });
    expect(review.statusCode, "没有 READY 音频的练习不允许进入复盘").toBe(409);
  });

  it("声明大小超过会话总量上限时拒绝且不落任何记录", async () => {
    const session = await createDraftSession(userId);
    const countBefore = await prisma.mediaAsset.count({ where: { sessionId: session.id } });
    const response = await request({
      method: "POST",
      url: `/api/v1/sessions/${session.id}/media/uploads`,
      body: uploadPayload({ sizeBytes: String(200 * 1024 * 1024 + 1) }),
    });
    expect(response.statusCode).toBe(413);
    const countAfter = await prisma.mediaAsset.count({ where: { sessionId: session.id } });
    expect(countAfter, "被拒绝的上传不得创建任何 MediaAsset").toBe(countBefore);
  });
});
