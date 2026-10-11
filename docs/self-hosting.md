# 自部署与协议验证

本说明对应 P5 运维基线（兼容保留 P1 文本 API 示例），使用 API/Worker 两进程和一个 PostgreSQL。原生 Apple 配对、聊天和世界管理已在 P2 实现，操作见 [P2 使用说明](p2-usage.md)；下列 P1 文本 API 流程仍保留兼容。

## 配置与启动

复制根目录 `.env.example` 为 `.env`，填写已经指向服务器的 HTTPS 域名及随机数据库密码。数据库密码使用 URL 安全字符（推荐随机十六进制），因为 Compose 将其放入连接 URL。`MASTER_KEY` 使用 `openssl rand -hex 32` 生成；独立安全保管，丢失后数据库中的模型凭据不能解密。密钥不要进入 Git、镜像或公开日志。

```sh
docker compose --env-file .env -f deploy/compose.yaml build
docker compose --env-file .env -f deploy/compose.yaml up -d
docker compose --env-file .env -f deploy/compose.yaml exec api node dist/packages/server/src/cli.js init
```

迁移服务先完成再启动 API/Worker；迁移持有数据库 advisory lock，重复运行不改变已应用迁移。`init` 在本机创建唯一主人并打印 5 分钟有效的一次性配对码；重复初始化不会创建第二位主人。配对码与会话令牌应仅提供给自己的设备。再次生成配对码用 CLI `pair` 或已认证的 `POST /v1/pairing/codes`。公网没有主人注册接口。

`GET /health` 验证数据库连接；`GET /v1/capabilities` 返回协议版本、实例 ID、data epoch 与可用能力。API/Worker 都会验证主密钥；密钥错误会拒绝启动。

## P1 最小文本流程

1. `POST /v1/pairing`，JSON 为 `{"code":"一次性码","device_name":"我的测试设备"}`。返回短期访问令牌和刷新令牌。
2. 后续请求使用 `Authorization: Bearer <access_token>`。访问令牌 15 分钟有效；`POST /v1/sessions/refresh` 使用刷新令牌换取新会话。重复使用旧刷新令牌会撤销整个轮换链。
3. `POST /v1/providers`，提交 `name, base_url, api_key, model, context_window, max_output_tokens`。`base_url` 是 OpenAI-compatible `/v1` 根地址。返回配置及凭据存在标记；读取接口不返回 Key。Key 会发送到用户指定服务器并加密保存，以供客户端关闭后执行。
4. 执行 `docker compose --env-file .env -f deploy/compose.yaml exec api node dist/packages/server/src/cli.js seed <provider-id>`，创建 P1 合成世界和房间，取得 `room_id`。P2 也可直接通过客户端创建世界、角色和房间。
5. `POST /v1/rooms/<room-id>/messages`，JSON 为 `{"client_command_id":"设备生成的UUID","content":"你好"}`。202 返回稳定 `message_id, run_id`；相同 ID 与正文重复发送返回相同 ACK，不同正文返回 409。
6. 可以立即关闭连接。通过 `GET /v1/runs/<run-id>`、`GET /v1/rooms/<room-id>/messages` 或同步接口找回服务器完成结果。

完整请求/响应见 `packages/contracts/openapi.json`。列表默认 50、上限 100；正文上限 32 KiB。`POST /v1/runs/<id>/cancel` 可重复调用；取消阻止后续数据库发布，已发出的模型请求可能产生消耗。

## 同步与失败语义

- 初次使用 `GET /v1/sync/snapshot`，保存 `high_water_cursor`；随后 `GET /v1/sync?cursor=<cursor>` 拉取增量。事件游标由同事务中的 owner 行锁分配。
- `GET /v1/events?cursor=<cursor>` 是 SSE，同步事件 ID 为持久游标；也接受 `Last-Event-ID`。客户端应保存应用到缓存的游标。撤销/到期会终止连接；断线不取消云任务。
- 410 要求重新获取快照。Worker 每分钟清理超过 7 天的同步事件，原消息保留。P2 客户端使用 10 分钟有效的固定水位分页快照，端点见 P2 使用说明。
- 同世界按命令顺序执行，不同世界可并行。每名发言者最多 3 次模型尝试，每次计入前台每日请求限额（默认 100）；每次有上下文/输出上限，整轮接力共用默认 120 秒上限（`MODEL_TIMEOUT_MS`）。
- 无可见正文的临时错误可以有限重试；已保存部分正文后断流/进程丢失标记 `interrupted`，不会透明拼接新回复。缺失 usage/进程中断记录 `unknown`，不假装消耗为零。
- 当前支持文本流及 P4 声明的远程 MCP 工具子集；结构化输出未通过能力验收。真实供应商兼容性待使用有效测试 Key 验证。

## 本机开发与故障定位

从源码启动时显式设置 `DATABASE_URL, MASTER_KEY, PUBLIC_URL`，执行 `npm run db:migrate`、`npm run owner:init`，再分别运行 `npm run dev:api` 和 `npm run dev:worker`。只有 `ALLOW_INSECURE_LOCAL=true` 才允许 HTTP loopback 模型服务与本机公共 URL；生产配置不启用此项。

模型端点阻断私有/特殊地址、嵌入凭据和重定向，并在连接时固定经过检查的 DNS 地址。默认日志只含状态/错误类别，不记录正文、模型 Key、完整模型返回或隐藏推理。

检查 `docker compose --env-file .env -f deploy/compose.yaml logs api worker migrate` 与 run 的 `error_code`。`credential_unavailable` 检查主密钥与版本；`model_http_401` 检查供应商配置；`request_budget_exceeded` 等待 UTC 次日或显式调整限额；`context_budget_exceeded` 需要减少输入或更换上下文更大的配置。

停止服务使用 Compose `stop`。数据库是持久卷；不要把 `down -v` 当作普通停止命令。P5 已提供完整备份、隔离恢复、data epoch 切换和密钥再加密工具，步骤与限制见 [备份恢复](recovery.md)。

## P4 升级注意

API 与 Worker 需使用相同 P4 版本并执行 `004_autonomy_and_tools.sql`。新增自主总开关、世界/类别与工具权限全部默认关闭；P3 记忆开关保留，但升级后需要补充明确授权才继续后台整理/索引。后台日预算按配置的 IANA 时区，环境变量为上限。MCP 凭据使用已有主密钥加密，备份必须保留数据库和该密钥。操作、协议子集和取消/未知结果边界见 [P4 使用说明](p4-usage.md)。

## P5 通知、导出与诊断

执行 `005_notifications_and_operations.sql`，API/Worker 使用同一个 P5 镜像。新增通知默认关闭，既有世界与后台权限保持原值。可选中继配置与 Apple 签名说明见 [通知指南](notifications.md)，备份、停源恢复、升级回退和密钥轮换见 [恢复指南](recovery.md)。

`GET /v1/diagnostics` 或本机 `cli.js diagnostics` 返回版本、实例/epoch、迁移校验和、各状态 run/通知数量与 Worker 心跳，无正文或密钥。API `/health` 检查数据库与维护状态；Worker 每次调度更新持久心跳，超过三十秒健康检查失败。Compose 重启策略负责进程退出后的拉起；healthcheck 本身不会自动重启仍存活但 unhealthy 的容器。

App 的“数据与诊断”可导出 JSON owner archive；也可认证调用 `POST /v1/exports` 或运行本机 `cli.js export`。归档带格式版本 1 和 SHA-256，保存角色版本、世界/消息/记忆来源、权限、导入原始字节及未知扩展，不导出设备会话、主密钥、模型/MCP/推送凭据。API 在一致性快照中分页读取，最大三十二 MiB；更大数据使用离线数据库备份。检查文件用 `node scripts/verify-export.mjs /private/echo-export.json`；checksum 对递归键排序后的 data 做 SHA-256，因此不受 Apple JSON 属性顺序变化影响。该 JSON 用于查阅/迁移，不是整实例恢复格式。

生产 Dockerfile 不含真实 `.env`、私钥或本机资源，使用非 root Node 用户，支持 linux/amd64 和 linux/arm64。`ECHO_IMAGE` 可覆盖固定镜像 tag/digest；多架构 CI 使用 Buildx 构建但不自动推送或部署。公开 HTTPS、DNS 和防火墙需部署者实际配置，当前本机验证不能代替公网证书联调。

## P6 0.6.0 候选与容量

新增 `006_snapshot_pages.sql`，分页 v1 响应不变；保留旧 records 和旧会话路径供 P5 回退。升级前备份，API/Worker用同一镜像，恢复操作遵循原有停源/密钥流程。分块随父快照过期或隐私删除清理，创建仍全量物化且临时存储增加。容量、真实模型评估和带校验和的本地候选包见 [P6 验证指南](p6-usage.md)；[P6 报告](p6-report.md)明示已验证与未通过门槛，不把0.6.0标签等同发行完成。
