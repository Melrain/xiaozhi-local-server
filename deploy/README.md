# 部署说明

| 项 | 值 |
|----|----|
| 站点 | https://xiaozhi.dingdangflash.com |
| UI 回环 | http://127.0.0.1:13500 |
| 设备 OTA | https://xiaozhi.dingdangflash.com/xiaozhi/ota/ |
| 设备 WebSocket | wss://xiaozhi.dingdangflash.com/xiaozhi/v1/ |
| 代码目录 | `/root/apps/xiaozhi-local-server` |
| 进程 | systemd `xiaozhi`（`tsx server.ts`，同时拉起 UI / OTA / WS / workers） |
| Caddy | `/etc/caddy/Caddyfile`（片段见 `caddy/xiaozhi.dingdangflash.com.caddy`） |
| SSH | `root@38.207.177.67 -p 7561` |
| CI/CD | GitHub Actions → SSH 部署（`.github/workflows/deploy.yml`） |

## DNS

| 类型 | 名称 | 内容 | 代理 |
|------|------|------|------|
| A | `xiaozhi` | `38.207.177.67` | **DNS only（灰云）** |

板子走 `https://xiaozhi.dingdangflash.com/xiaozhi/ota/`，OTA JSON 下发 `wss://xiaozhi.dingdangflash.com/xiaozhi/v1/`。DNS 必须灰云，否则 ESP32 不好过橙云。

## 持续部署

推送到 `main` 或手动 `workflow_dispatch` 会自动部署：

```bash
git push origin main
```

GitHub Secrets：

| Secret | 说明 |
|--------|------|
| `VPS_HOST` | `38.207.177.67` |
| `VPS_PORT` | `7561` |
| `VPS_USER` | `root` |
| `VPS_SSH_KEY` | GitHub Actions 专用私钥 |

VPS 侧：

- 仓库 deploy key（只读，`~/.ssh/xiaozhi_github_deploy`）用于 `git fetch`
- 生产环境变量在 `/root/apps/xiaozhi-local-server/.env`（**不会被 git 覆盖**）
- `DASHSCOPE_API_KEY` 与 `DASHSCOPE_WORKSPACE_ID` 填了才会接通 Qwen-Omni Realtime

手动部署：

```bash
ssh -p 7561 root@38.207.177.67 'bash /root/apps/xiaozhi-local-server/deploy/deploy.sh'
```

## 常用运维

```bash
systemctl status xiaozhi
systemctl restart xiaozhi
journalctl -u xiaozhi -f
curl -sS http://127.0.0.1:8002/health
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:13500/worker/listen-ws.worker.js
caddy validate --config /etc/caddy/Caddyfile && systemctl reload caddy
```
