# 小智本地服务（xiaozhi-local-server）

给局域网里的小智 ESP32-S3 固件用的本地服务。前端是 Next.js（App Router），设备协议仍走固件已经配置好的端口，不必重新配网或 OTA。

`npm run dev` / `npm start` **会同时启动三个端口**：

| 用途 | 绑定 | 路径 |
| --- | --- | --- |
| Next.js 界面 | `0.0.0.0:3000` | `/` |
| OTA HTTP | `0.0.0.0:8002` | `GET/POST /xiaozhi/ota/`（也接受 `/xiaozhi/ota`、`/xiaozhi/ota/activate`） |
| WebSocket | `0.0.0.0:8000` | `/xiaozhi/v1/`（也接受 `/xiaozhi/v1`） |

全部监听 `0.0.0.0`，不要绑 `127.0.0.1`。写进 OTA JSON、给板子看的主机名由 `ADVERTISE_HOST` 决定，默认 `192.168.50.188`。

当前**不接 ASR/TTS**。能完成 OTA 配置、WebSocket 立即回 `hello`、记录 `listen` / `opus` / MCP，并回和现在一样的占位 JSON。

## 克隆与启动

```bash
git clone <本仓库>
cd xiaozhi-local-server
cp .env.example .env.local   # 按需改通告 IP
npm install
npm run dev
```

生产模式：

```bash
npm run build
npm start
```

一条命令就会拉起界面 + OTA + WebSocket。自定义入口在仓库根目录的 `server.ts`。

## 环境变量

见 `.env.example`：

- `ADVERTISE_HOST` 默认 `192.168.50.188`（写进 `websocket.url`，不是 bind 地址）
- `OTA_PORT` 默认 `8002`
- `WS_PORT` 默认 `8000`
- `UI_PORT` 默认 `3000`

## 防火墙

放行本机 **3000 / 8000 / 8002**（TCP）。板子在局域网访问这些端口，拦了就连不上。

## 怎么验证

1. **浏览器或 curl 测 OTA**（GET 也返回同一份 JSON，方便肉眼看）：

   ```bash
   curl -sS http://127.0.0.1:8002/xiaozhi/ota/
   ```

   应得到 HTTP 200 JSON，其中 `websocket.url` 类似：

   `ws://192.168.50.188:8000/xiaozhi/v1/`

   `firmware.url` 必须是空字符串，避免板子去刷固件。响应里**没有** `activation`、`mqtt`。

   健康检查：`curl -sS http://127.0.0.1:8002/health`

2. **板子连 WebSocket**：设备 OTA 已设为 `http://192.168.50.188:8002/xiaozhi/ota/`。按 ESP32 的 **BOOT** 键打开音频通道。服务端一连上就立刻发 `hello`（不等设备先发，避免 1006）。终端里会看到 connect / hello sent / listen / opus 帧数 / close code。

## 协议要点（不要改）

- OTA：回 `server_time`、`firmware`（版本回显 `application.version`，没有则 `2.4.2`）、`websocket`。
- WebSocket：单个 `WebSocketServer` 挂在 8000 的 HTTP 服务上，不按 path 再拆一套。
- 连上立刻发 `type: hello`，`audio_params.sample_rate` 为 `24000`。
- 文本：`hello`（可再回一次）、`listen` start/stop/detect、`abort`、`mcp`（initialize / notifications/initialized / tools/list 空列表 / 其它 `result: true`）。
- 二进制当作 Opus；大约 1.8 秒空闲后回 stt、llm（emotion happy）、tts start / sentence_start / stop。暂不下发 Opus，喇叭不会出声。
