# P0–P1 实施与验证记录

日期：2026-10-10（Asia/Shanghai）。用户指令“读取开发指南，开始实现 P0–P1”授权 T00–T03。当前没有 Git 提交、推送、云资源或公网部署。

## 交付与边界

| 任务 | 已交付                                                                                                                                   | 未决 / 下一步                                                                      |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| T00  | 同步阶段状态、保持多角色首版范围、记录 ADR-014                                                                                           | 服务端/客户端许可证仍待定，未创建 LICENSE；当前实现不等同完整首版                  |
| T01  | npm workspace/锁文件、严格 TS、TypeBox/OpenAPI、编号 SQL 迁移、API/Worker、Docker/Compose/Caddy、CI、iOS/macOS 工程与共享 Swift 包       | CI 文件已创建但未在 GitHub 运行；签名发行、公开 HTTPS 证书、Linux amd64 镜像未验收 |
| T02  | 本机初始化单主人、5 分钟一次性码/数据库限速、哈希会话、刷新轮换与重用撤销、设备撤销、加密模型配置、主密钥版本及启动校验                  | MCP 连接接入 T09；再加密密钥轮换和备份恢复 T12                                     |
| T03  | 持久命令/202 ACK、pg-boss/outbox、世界排序/租约/fencing、流式保存/终态、有限重试/取消、usage/请求预算、快照/增量/SSE、模拟服务与故障测试 | 真实模型兼容未验证；角色/世界 CRUD、上下文编译和 Apple 聊天界面从 T04/T05 开始     |

后端路径在 `packages/server/src/`；迁移在 `migrations/001_foundation.sql`；协议来源在 `packages/contracts/src/index.ts`，生成文件在 `packages/contracts/openapi.json` 与共享 Swift 包的 `openapi.json`。生成 Swift API 类型/客户端由官方构建插件完成；不手改生成文件。部署配置在 `deploy/`，操作入口见 [自部署说明](self-hosting.md)。

## 固定环境

后端验收使用 Linux arm64 容器：Node 24.14.0、npm 11.9.0、PostgreSQL 17、pgvector 0.8.2。核心依赖：Fastify 5.12.5、pg 8.23.1、pg-boss 12.37.1、TypeBox 0.34.52、TypeScript 5.9.3、Vitest 5.0.3；完整版本以 `package-lock.json` 为准。Node/数据库/Caddy 基础镜像固定 digest。

Apple：Xcode 27.0（27A266a）、Swift 6.4、iOS Simulator/macOS SDK 27.0，部署目标仍为 iOS 18/macOS 15。固定 Swift OpenAPI Generator 1.14.0、Runtime 1.13.0、URLSession 1.3.2，传递依赖保存在 `Package.resolved`。生成代码出现 unused public import 警告，构建通过；没有运行真机或通知测试。

本机默认 Node 25.9.0/PostgreSQL 18.3 不作为后端验收环境。依赖审计发现的开发依赖 esbuild 问题通过固定 0.28.1 override 修复；最终镜像安装输出为 0 vulnerabilities。

## 已执行验证

| 命令 / 检查                                                                                                                                         | 结果与证据                                                                                     |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 固定镜像内 `npm ci --ignore-scripts` 与 `npm run build`                                                                                             | 成功；开发及非 root 正式镜像均已构建                                                           |
| `npm run typecheck`、`npm run contracts:check`                                                                                                      | 通过；TypeBox 生成契约与 Apple 输入一致                                                        |
| 固定镜像内 `npm test`                                                                                                                               | 3 个单元测试通过：配置、认证加密上下文/篡改/错误主密钥、端点限制                               |
| `docker compose -f deploy/compose.test.yaml up --build --abort-on-container-exit --exit-code-from tests`                                            | 空临时库完成迁移，24 个集成测试通过，退出码 0                                                  |
| 正式镜像 CLI `migrate` / `init`、API / Worker 启动                                                                                                  | 成功；`/health` 为 ok，capabilities 为 v1；API/Worker 优雅停止退出码均为 0，临时测试容器已清理 |
| `docker compose ... config -q`                                                                                                                      | Compose 与固定 Caddy 镜像内的配置验证通过；没有启动公开 HTTPS 服务                             |
| `swift test --package-path apps/apple/Packages/CompanionCore --scratch-path .local/swift-build`                                                     | 共享包、生成 REST 客户端编译通过；1 个 Swift Testing 测试通过                                  |
| `xcodebuild ... -scheme Companion-iOS -destination 'generic/platform=iOS Simulator' ... CODE_SIGNING_ALLOWED=NO -skipPackagePluginValidation build` | BUILD SUCCEEDED                                                                                |
| `xcodebuild ... -scheme Companion-macOS -destination 'platform=macOS' ... CODE_SIGNING_ALLOWED=NO -skipPackagePluginValidation build`               | BUILD SUCCEEDED                                                                                |

本地构建日志保存在忽略的 `.local/`：`integration.log`、`docker-runtime-build.log`、`swift-test.log`、`ios-build.log`、`macos-build.log`。可复现命令在根 README，测试源文件是长期证据。这里只记录最终通过结果；前期测试发现范围、Swift 包兼容和类型命名问题已修复。

## 故障和权限证据

`tests/integration/p1.test.ts` 的 24 个场景覆盖：

- 一次性码重放/过期/持续限速、无注册入口、刷新重用撤销、设备 REST/刷新/SSE 撤销。
- 模型 Key 读取/数据库密文保护、错误主密钥、注入数据库错误后的日志脱敏、未知写字段拒绝、不可读取另一个 owner ID 的房间。
- 并发相同命令 10 次只有一个 run/outbox，冲突正文返回 409；断开 HTTP 客户端后后台完成并找回相同结果。
- outbox 无 Worker 时保留、重复队列投递只完成一次、同世界顺序/未来排队输入不污染当前 prompt。
- 损坏流、部分流中断、工具调用或长度截断拒绝伪装 completed；429 最多 3 次尝试，每次计费；缺 usage 标记 unknown。
- 上下文溢出零模型请求、两个世界争最后一次请求额度至多一个调用、取消阻止迟到发布、无正文超时有限重试。
- 真实 Worker 子进程 SIGKILL：无正文时重启后恢复，同 run 只有两条权威消息；已保存部分正文时保留 interrupted，不再调用模型。
- 租约过期旧 Worker 不能心跳/提交；模型等待期间没有 idle in transaction；迁移并发/重复无变化；游标按提交顺序分配；快照/增量可读完成状态，过期水位返回 410。

测试只使用合成“星港”文本、测试凭据和本机模拟模型，没有调用付费模型、现实工具或中继。A01–A06 的 P1 服务端部分已有证据；A07/A29/A32 只有服务端顺序、水位与 v1 能力基线，完整 Apple 联调仍需后续任务。其余角色/记忆/自主/MCP/恢复/通知验收不标记通过。

## 限制与下一步

P1 提供文本协议测试助手，未将其作为单伴侣产品定案。世界/角色/群聊、世界书、记忆、自主剧情、MCP 与通知仍是首版必需项。当前模型能力为 declared，未有有效 Key，因此不能宣称已兼容两家真实模型或达到中文剧情评分。

同步自动保留期、大快照分页、Apple Keychain/SwiftData/待发送队列属于 T05。后台自动预算属于 T10；P1 只提供前台每日请求额度和单次上下文/输出/超时边界。没有完整备份、恢复 epoch 切换、再加密轮换或签名发行功能；未测试容量目标、24 小时无人运行、APNs。

下一步按依赖进入 T04（角色/世界/上下文）与 T05（双端配对、聊天和同步），随后 T06 实现多角色与知识隔离。许可证待首次发布前决定。
