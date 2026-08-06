# OCFreeRelay

[English](README.md) | **简体中文**

独立的 **OpenCode 免费 Worker** LLM 网关：一个 OpenAI 兼容的中继，用自己的 API Key 提供 OpenCode 免费模型。

- 接受 **OpenAI 兼容**的客户端请求（`/v1/chat/completions`、`/v1/models`）
- **透明转发**到 `https://opencode.ai/zen/v1`（可配置）
- **仅免费模型**：自动抓取 Zen 定价页面，只提供免费模型（列表 + 对话）；付费模型永不暴露
- 多 Key / 多账号 **429 前粘性绑定**，之后轮换 + 冷却（保持提示词缓存热度）
- 可选 **OpenCode CLI 身份请求头**合成（Cloudflare / VPS）
- 最小化的免费模型请求体修复（去除 `client_metadata`、思考模型的 `reasoning_content`、effort 别名等）
- `/` 提供**管理页面**，管理 Key、Base URL、代理和状态

## 快速开始

```bash
npm install
npm run build
npm start
# 或: npm run dev
```

默认端口：**9876**（可通过 `PORT` 或管理后台设置覆盖）。

- 管理后台：http://127.0.0.1:9876/
- 对话：`POST http://127.0.0.1:9876/v1/chat/completions`
- 模型列表：`GET http://127.0.0.1:9876/v1/models`

## 配置

| 来源 | 用途 |
|--------|---------|
| 管理后台 | Base URL、Worker（API Key）、代理池绑定、CLI 请求头合成 |
| `data/settings.json` | 持久化设置（自动创建） |
| `PORT` | 监听端口 |
| `OCFREERELAY_SETTINGS_PATH` | 自定义设置文件路径 |
| `OPENCODE_SYNTHESIZE_CLI_HEADERS` | 设为 `true` 合成 CLI 身份请求头（也可在管理后台开关） |
| `OPENCODE_USER_AGENT` / `OPENCODE_CLIENT` / `OPENCODE_PROJECT` | CLI 默认值 |
| `OCFREERELAY_PRICING_URL` | 覆盖用于抓取免费模型的 Zen 定价页面 URL |

## 仅免费模型服务

本网关**只提供免费模型**——付费模型永远不会暴露给客户端。

- 启动时抓取 OpenCode Zen 定价页面（`https://opencode.ai/docs/zen`），保留所有输入/输出价格均为 `Free` 的模型。
- `GET /v1/models` 只返回这些免费模型（上游的付费条目会被丢弃）。
- `POST /v1/chat/completions` 会在**任何上游调用之前**，以 `403 model_not_allowed` 拒绝非免费模型的请求。
- 抓取结果缓存到 `data/free-models.json`。抓取失败时保留上一次成功的集合；首次成功抓取之前使用当前已知免费 ID 的静态基线。

当前免费模型：

```text
big-pickle  deepseek-v4-flash-free  mimo-v2.5-free  laguna-s-2.1-free
ling-3.0-flash-free  longcat-2.0-free  north-mini-code-free  nemotron-3-ultra-free
```

## 代理池（OpenCode 免费账号的 IP 隔离）

OpenCode 免费账号经常受 **IP 限制**。将每个 Worker 绑定到不同的池代理：

1. **手动** — 管理后台 → 代理池 → 添加 HTTP/SOCKS5 host:port
2. **Clash 订阅** — 添加订阅 URL → **拉取**（fetch）
   - 会尝试多个 User-Agent（优先 `clash`）。部分机场只有用 `clash` UA 才返回完整 YAML；其他 UA 返回 base64 的 `vless://` 列表。
   - 导入 `http`/`socks`（直连）**以及** `vless`/`hysteria2`/`tuic`/…（经 Clash 桥接）
3. **Clash 桥接** — 用于协议节点：
   - 本地运行 Mihomo/Clash Meta，使用**同一**订阅
   - 在管理后台开启桥接：controller `http://127.0.0.1:9090`、混合端口（通常是 `7892`）、选择组 `主代理`
   - 网关按 Worker 切换选择组，然后经本地 HTTP 代理出站
4. **绑定** — 每个 Worker 通过 `proxyId` 选择池中节点

## 测试

```bash
npm test
```

## 许可证

MIT

## 社区

- [Linux.do](https://linux.do) — 开源与开发者社区讨论
