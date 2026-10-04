/**
 * Worker 集成测试环境变量：必须在任何业务模块之前就绪。
 */
process.env.NODE_ENV = "test";
process.env.DATABASE_URL = "postgresql://postgres:postgres@127.0.0.1:5432/pglite";
process.env.REDIS_URL = "redis://127.0.0.1:6379";
process.env.S3_ENDPOINT = "http://127.0.0.1:9000";
process.env.S3_REGION = "us-east-1";
process.env.S3_BUCKET = "practice-audio-test";
process.env.S3_ACCESS_KEY = "test";
process.env.S3_SECRET_KEY = "test";
process.env.S3_FORCE_PATH_STYLE = "true";
process.env.LOG_LEVEL = "silent";
