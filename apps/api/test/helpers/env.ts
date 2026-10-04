/**
 * 集成测试环境变量必须在任何业务模块 import 之前就绪：
 * src/config/env.ts 在首次调用 getConfig() 时缓存配置，src/lib/prisma.ts
 * 在模块加载时就会读取 NODE_ENV。
 */
process.env.NODE_ENV = "test";
process.env.DATABASE_URL = "postgresql://postgres:postgres@127.0.0.1:5432/pglite";
process.env.REDIS_URL = "redis://127.0.0.1:6379";
process.env.JWT_ACCESS_SECRET = "test-jwt-access-secret-at-least-32-bytes!!";
process.env.REFRESH_TOKEN_PEPPER = "test-refresh-pepper-at-least-32-bytes!!!!";
process.env.S3_ENDPOINT = "http://127.0.0.1:9000";
process.env.S3_REGION = "us-east-1";
process.env.S3_BUCKET = "practice-audio-test";
process.env.S3_ACCESS_KEY = "test";
process.env.S3_SECRET_KEY = "test";
process.env.S3_FORCE_PATH_STYLE = "true";
process.env.PUBLIC_API_ORIGIN = "http://127.0.0.1:3000";
process.env.WEB_ORIGIN = "http://127.0.0.1:5173";
process.env.METRICS_ENABLED = "false";
process.env.LOG_LEVEL = "silent";
