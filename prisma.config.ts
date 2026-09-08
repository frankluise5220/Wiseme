import dotenv from "dotenv";
import { defineConfig } from "prisma/config";

// 只在 DATABASE_URL 未设置时才从 .env 加载，避免覆盖容器环境变量
if (!process.env["DATABASE_URL"]) {
  dotenv.config({ path: ".env" });
  dotenv.config({ path: ".env.local", override: true });
}

export default defineConfig({
  schema: process.env["PRISMA_SCHEMA_PATH"] || "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: process.env["DATABASE_URL"],
  },
});
