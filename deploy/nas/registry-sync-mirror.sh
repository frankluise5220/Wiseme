#!/usr/bin/env bash
# MMH Docker 镜像同步脚本
# 从 GHCR 拉取最新 mmh / mmh-updater 镜像，打本地标签后 push 到 VPS 自建 registry。
# 用户把 .env 里的 MMH_APP_IMAGE / MMH_UPDATER_IMAGE 指向 fnapp.floatingice.win:5000/frankluise5220/... 即可从 VPS 拉取。
# 用法：crontab 每小时执行一次：
#   10 * * * * /opt/mmh-registry/sync-mirror.sh >> /opt/mmh-registry/sync.log 2>&1
set -uo pipefail

# 对外公布的 registry 地址（域名，IP 变化不影响）
REGISTRY="fnapp.floatingice.win:5000"
# 本机 tag/push 统一用 localhost（registry 按 namespace/仓库名存储，前缀不影响用户拉取）
LOCAL_REGISTRY="127.0.0.1:5000"
GHCR="ghcr.io/frankluise5220"
NAMESPACE="frankluise5220"
IMAGES=("mmh" "mmh-updater")
LOG_TAG="[$(date '+%Y-%m-%d %H:%M:%S')]"

echo "$LOG_TAG ==== MMH 镜像同步开始 ===="

for img in "${IMAGES[@]}"; do
  echo "$LOG_TAG 同步 $img ..."
  # 1. 从 GHCR 拉最新
  if ! docker pull "${GHCR}/${img}:latest" >/dev/null 2>&1; then
    echo "$LOG_TAG 拉取 ${GHCR}/${img}:latest 失败"
    continue
  fi
  # 2. 打本地 registry 标签（保留 namespace，与 GHCR 路径一致）
  docker tag "${GHCR}/${img}:latest" "${LOCAL_REGISTRY}/${NAMESPACE}/${img}:latest" || { echo "$LOG_TAG tag 失败"; continue; }
  # 3. push 到本地 registry
  if docker push "${LOCAL_REGISTRY}/${NAMESPACE}/${img}:latest" >/dev/null 2>&1; then
    echo "$LOG_TAG ${img}:latest 已同步（对外 ${REGISTRY}/${NAMESPACE}/${img}:latest）"
  else
    echo "$LOG_TAG push ${LOCAL_REGISTRY}/${NAMESPACE}/${img}:latest 失败"
  fi
done

echo "$LOG_TAG ==== 同步完成 ===="
