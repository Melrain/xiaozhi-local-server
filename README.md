# 小智本地服务（xiaozhi-local-server）

给局域网里的小智 ESP32-S3 固件用的本地服务。前端是 Next.js（App Router），设备协议仍走固件已经配置好的端口，不必重新配网或 OTA。

`npm run dev` / `npm start` **会同时启动三个端口**：

| 用途 | 绑定 | 路径 |
| --- | --- | --- |
| Next.js 界面 | `0.0.0.0:3000` | `/` |
| OTA HTTP | `0.0.0.0:8002` | `GET/POST /xiaozhi/ota/`（也接受 `/xiaozhi/ota`、`/xiaozhi/ota/activate`） |
| WebSocket | `0.0.0.0:8000` | `/xiaozhi/v1/`（也接受 `/xiaozhi/v1`） |

全部监听 `0.0.0.0`，不要绑 `127.0.0.1`。写进 OTA JSON、给板子看的主机名由 `ADVERTISE_HOST` 决定，默认 `192.168.50.188`。

ESP32 仍是薄客户端：采集 Opus 上行、播放 Opus 下行、hello / listen / abort / mcp。ASR / LLM / TTS 都在阿里云百炼 **Qwen-Omni Realtime**。本服务只做协议桥。

未填写百炼密钥时，行为与以前相同：记日志，约 1.8 秒空闲后回占位 stt / llm / tts JSON，不下发 Opus。

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
- `DASHSCOPE_API_KEY` 百炼 API Key（留空则 Realtime 关闭，走占位）
- `DASHSCOPE_WORKSPACE_ID` 业务空间 ID，用来拼北京 `wss://{id}.cn-beijing.maas.aliyuncs.com/...`
- `DASHSCOPE_REALTIME_MODEL` 默认 `qwen3.5-omni-flash-realtime`
- `DASHSCOPE_REALTIME_VOICE` 默认 `Tina`（也可改成文档里的 `Ethan`）
- `DASHSCOPE_REALTIME_URL` 可选，覆盖完整 wss 地址
- `DASHSCOPE_INSTRUCTIONS` 可选，覆盖桌面机器人人设

密钥只放在 `.env.local`，不要提交。缺少 `DASHSCOPE_API_KEY` 或 `DASHSCOPE_WORKSPACE_ID` 时，终端会打：

`Realtime disabled: set DASHSCOPE_API_KEY and DASHSCOPE_WORKSPACE_ID`

## 实时语音（Qwen-Omni）

架构不变：`ESP32（原厂小智固件）↔ :8000 /xiaozhi/v1/ ↔ 本服务桥 ↔ 百炼 Realtime WebSocket`。OTA 仍是 `:8002`，设备 WS 仍是 `:8000`，不要改固件协议。

1. 把上面三个必填项写进 `.env.local`：`DASHSCOPE_API_KEY`、`DASHSCOPE_WORKSPACE_ID`，模型可沿用 flash。
2. `npm run dev`，仪表盘会显示 Realtime 是否已配置、连上没有、模型名、上次打断原因。
3. 板子按 **BOOT** 打开音频通道（和以前一样）。连上后服务端立刻 `hello`，并建立一路百炼会话。
4. 对着麦克风说话：上行 Opus 解码成 PCM、重采样到 16 kHz，送给 Realtime；下行 PCM 编成 24 kHz / 60 ms Opus 播到喇叭。
5. **打断（barge-in）**：说话盖住回复、或固件发 `abort` / 新的 `listen start`，服务端会 `response.cancel`、清空下行队列、发 `tts stop`，喇叭不会叠音。

没有密钥时，BOOT 仍能连上，只是走占位 JSON，方便本地看握手。

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
- 二进制当作 Opus。未配置 Realtime 时：大约 1.8 秒空闲后回 stt、llm（emotion happy）、tts start / sentence_start / stop，暂不下发 Opus。
- 配置了 Realtime 时：上行持续转发给百炼（播放时也转，便于打断）；下行按 `tts start` / `sentence_start` / Opus 二进制 / `tts stop` 回给板子。
