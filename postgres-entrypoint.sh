#!/bin/bash
set -e

# MMH PostgreSQL 初始化脚本
# 在 Docker 容器首次启动时由 /docker-entrypoint-initdb.d 自动执行

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
  -- 确保 public schema 可用
  CREATE SCHEMA IF NOT EXISTS public;
  GRANT ALL ON SCHEMA public TO "$POSTGRES_USER";

  -- 启用常用扩展
  CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
  CREATE EXTENSION IF NOT EXISTS "pgcrypto";

EOSQL

echo "MMH 数据库初始化完成"
