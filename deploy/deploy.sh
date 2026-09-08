#!/usr/bin/env bash
# 在 VPS 上手动部署（GitHub Actions 也执行同等逻辑）
# 用法: bash deploy/deploy.sh
set -euo pipefail

APP_DIR="${APP_DIR:-/root/apps/xiaozhi-local-server}"
cd "$APP_DIR"

export GIT_SSH_COMMAND="${GIT_SSH_COMMAND:-ssh -i /root/.ssh/xiaozhi_github_deploy -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new}"
export NODE_ENV=production
export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=1536}"

echo "==> $(date -Is) deploy in $APP_DIR"
git remote set-url origin git@github.com:Melrain/xiaozhi-local-server.git
git fetch --prune origin main
git checkout main
git reset --hard origin/main

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

echo "==> install deps"
if [ -f package-lock.json ]; then npm ci --include=dev; else npm install; fi

echo "==> build"
npm run build

if [ -f deploy/xiaozhi.service ]; then
  cp -f deploy/xiaozhi.service /etc/systemd/system/xiaozhi.service
  systemctl daemon-reload
  systemctl enable xiaozhi >/dev/null
fi

systemctl restart xiaozhi
sleep 2
systemctl is-active --quiet xiaozhi
systemctl --no-pager --full status xiaozhi | head -20

echo "==> health check"
ok=0
for i in 1 2 3 4 5 6 7 8 9 10 12 15 18 20; do
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 3 http://127.0.0.1:13500/ || true)
  echo "  try $i UI => HTTP $code"
  if [ "$code" = "200" ] || [ "$code" = "307" ] || [ "$code" = "302" ]; then
    ok=1
    break
  fi
  sleep 2
done
if [ "$ok" != "1" ]; then
  echo "UI health check failed"
  journalctl -u xiaozhi -n 40 --no-pager || true
  exit 1
fi

ota=$(curl -s -o /dev/null -w "%{http_code}" --max-time 3 http://127.0.0.1:8002/health || true)
echo "  OTA /health => HTTP $ota"
worker=$(curl -s -o /dev/null -w "%{http_code}" --max-time 3 http://127.0.0.1:13500/worker/listen-ws.worker.js || true)
echo "  worker => HTTP $worker"
if [ "$ota" != "200" ] || [ "$worker" != "200" ]; then
  echo "OTA/worker health check failed"
  journalctl -u xiaozhi -n 40 --no-pager || true
  exit 1
fi

echo "==> deploy ok @ $(git rev-parse --short HEAD)"
