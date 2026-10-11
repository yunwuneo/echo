# P4 实施与验证记录

实施日期：2026-10-11（Asia/Shanghai）。用户“继续进行 P4 的实现”授权 T09–T10。测试仅使用合成剧情、模拟模型与本机假 MCP 服务；没有真实付费模型请求、现实工具动作、云资源、公网部署、Git 提交或推送。

## 交付

| 任务 | 已实现行为                                                                                                                                                               | 边界                                                                                                    |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| T09  | 官方 MCP SDK、Streamable HTTP 与显式旧 SSE、工具发现与受限 schema、连接凭据加密、角色/世界授权、固定资源长期授权、逐次审批、恢复检查点与人工核对、双端连接/授权/活动界面 | 无 OAuth、STDIO 或 MCP Server；真实供应商工具调用与远程 MCP 服务兼容性尚未验证；活动列表显示最近 100 条 |
| T10  | 总/世界/类别开关、持久触发时间、时区/静默/冷却、主动联系与有限角色互动、跨类别后台预算、用户优先、关闭开关的提交隔离、确定性原文回顾与已读水位、双端设置/用量/回顾       | 使用加速虚拟时钟验证 24 小时窗口，不宣称 24 小时墙钟耐久测试；回顾使用实际消息摘录，无额外摘要模型      |

主要文件为 `migrations/004_autonomy_and_tools.sql`、`packages/server/src/modules/{mcp,autonomy}`、`packages/contracts/src/p4.ts`、`apps/apple/Shared/{MCPView,AutonomyView}.swift`，同时更新 `runs/llm/memory/queue/sync`、OpenAPI 与生成客户端适配。精确操作、限额和兼容矩阵见 [P4 使用说明](p4-usage.md)，决策见 [ADR-017](product-and-decisions.md)。

## 权限、可靠性与隐私

- 所有新权限默认关闭。既有 P3 记忆设置不会自动获得新后台权限，升级后需明确开启总开关、世界和记忆类别。前台工具有独立的实例/世界读写开关与角色授权；后台工具还需通过自主类别和预算检查。
- 审批绑定实际参数、schema 指纹、连接/授权/世界/策略修订与期限；模型和工具注释不能授予权限。等待审批释放世界租约，执行前重新发现并校验工具定义，批准接口不能替换参数。
- 外部模型和 MCP 请求均在事务之外。发出工具请求前持久保存 executing；响应丢失、dispatch 边界崩溃或取消后的结果记录 outcome_unknown，禁止自动重发。人工核对已取消 run 的状态不会恢复运行，不承诺现实副作用恰好一次。
- 工具结果有输入、网络和上下文上限；作为非可信 tool 消息使用。凭据不进入配置读取或模型输入，远端回显凭据会在保存、同步和继续生成前清理，工具发现若包含凭据则拒绝。
- 默认公共 HTTPS；内网仅按连接列出精确 IP，每次请求校验 DNS 并固定连接地址，拒绝重定向、跨 origin SSE endpoint、元数据和 link-local 等地址。无全局内网放行。
- 来源遗忘会清除派生工具参数和结果，保留副作用状态元数据；未完成动作与旧 transcript 不能重新引入遗忘内容。日志沿用不记录正文、完整返回和密钥的约束。
- 自主任务沿用同一 RunEngine。全实例最多一个未结束自主 run，单轮最多 3 条角色消息；用户命令在下一发言边界优先。开关修订在领取和提交复查，停机后只评估当前机会，不补发全部过期窗口。模型 `<skip>` 不生成假消息或回顾。
- 请求和 token 预算按 IANA 本地日期事务预留，实例/世界/类别共同生效；失败与继续生成也计费，缺失 usage 标 unknown。实际用量另记、预留不退款，不估算货币价格。记忆、嵌入和自主剧情共用后台上限。

## 验证证据

- 固定 Node 24.14.0、PostgreSQL 17 + pgvector 的完整集成测试 **83/83**：P1 24、P2 15、P3 16、P4 28 项；最终日志 `.local/p4-integration-final.log`。覆盖空库、已有 P3 数据升级、新权限默认关闭、重复迁移不改变状态。
- P4 工具回归覆盖 HTTP/SSE 读取与写入、默认无授权、审批/拒绝/过期、撤销和 schema 改变、固定资源范围、跨角色/世界隔离、401/429、重定向/SSRF/跨 origin SSE、超长及恶意返回、最多 4 次调用、写入后响应丢失、dispatch 崩溃恢复、取消后人工核对、凭据回显与来源遗忘。
- P4 自主回归覆盖所有客户端断开、Worker 重启、回顾和原文一致、安静时段/冷却、停机窗口、每日限额、skip、关闭再开启后的旧结果、用户插入优先、跨类别预算和未知 usage、多个世界争最后一个请求，以及加速模拟 24 小时离线窗口。
- 固定 Node **24.14.0 / npm 11.9.0** 的 `lint`、`typecheck`、单元测试 **21/21**、`test:evals`、`contracts:check`、`build` 全部通过，日志 `.local/p4-node24-checks.log`。新增单元验证 IANA 日期及 DST、schema/资源参数、恶意结果上限、DNS 混合与重绑定地址；沿用中文合成词项检索集 100 查询，recall@5 为 **80/80**、负例误召回 **0/20**、真实模型调用 **0**，不代表语义泛化评估。
- 本地生产镜像 `echo2-server:p4-local` 构建通过，日志 `.local/p4-runtime-build.log`；未部署镜像，远程 CI 未运行。
- Swift 共享包 **7/7**，日志 `.local/p4-swift.log`。包括缓存、同步解析、实例隔离和遗忘后隐私重建；本阶段未新增仅重复界面实现的单元测试。
- 最终 iOS、macOS 构建均通过；macOS 日志 `.local/p4-macos-build.log`，iOS 随下述完整 UI 套件重新编译验证。
- iPhone 模拟器完整 UI 套件 **3/3**，日志 `.local/p4-ios-ui-rechecked.log`、结果 `.local/p4-ios-ui-rechecked.xcresult`、截图 `.local/p4-ios-final-artifacts/`。P4 用例验证批准前零模拟写入、批准后恰好一次模拟写入，开关在服务端实际生效，App 终止后后台完成主动消息，重启后从回顾整行点击跳转原文；同时回归记忆纠正/遗忘/导入和配对/离线聊天/进程重启。已检查审批参数和回顾截图，正文、按钮及时间均可读。

联调发现并修复了实际问题：同一 owner 的命令锁与后台 usage 外键检查形成死锁，将不修改主键的锁改为 `FOR NO KEY UPDATE`；SwiftUI List 同行多个默认按钮可能共同触发，改为独立按钮样式，并以服务端动作次数验收；回顾行改为普通文字样式后空白处不可点击，补全整行点击区域。最终回归还修复了来源失效检查未参与旧 run 领取判定，以及测试时钟毫秒截断造成到期边界的不确定性。失败运行保留，但不计入通过结果。

`.local/p4-ios-ui-final.log` 是发现回顾点击问题的失败运行；三个用例结束后 Xcode 卡在报告收集，已终止该进程。上述 `rechecked` 是修复后用干净临时数据库从头运行并正常返回 `TEST SUCCEEDED` 的最终证据。测试结束后已清理本阶段专用 Compose 容器与网络。

## 复现

固定 Node 的检查使用仓库 Dockerfile 的 development 目标；无需使用主机 Node 版本。集成与 UI 数据库均为专用临时数据库，不读取生产 `.env`。

```sh
docker build --target development -t echo2-server:p4-check .
docker run --rm echo2-server:p4-check sh -c 'npm run lint && npm run typecheck && npm test && npm run test:evals && npm run contracts:check && npm run build'
docker compose -f deploy/compose.test.yaml -p echo2-p4-tests up --build --abort-on-container-exit --exit-code-from tests
docker compose -f deploy/compose.test.yaml -p echo2-p4-tests down
docker build -t echo2-server:p4-local .
```

Apple 共享包测试使用 `swift test --package-path apps/apple/Packages/CompanionCore`。iOS UI 服务只绑定 `127.0.0.1:3012`；完整套件开始前应重建临时数据库，避免已有模拟写入影响审批计数。下列 UUID 是本机 iPhone 17 Pro Max，其他机器请使用实际模拟器 UUID；已有 xcresult 目录需换一个名称。

```sh
docker compose -f deploy/compose.ui-test.yaml -p echo2-p4-ui down
docker compose -f deploy/compose.ui-test.yaml -p echo2-p4-ui up -d --build
xcodebuild -project apps/apple/Companion.xcodeproj -scheme Companion-iOS -destination 'platform=iOS Simulator,id=34F8DBDA-87C9-4518-960E-56D6A03321CB' -derivedDataPath .local/ios -resultBundlePath .local/p4-ios-ui-rechecked.xcresult CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=- -skipPackagePluginValidation test
xcodebuild -project apps/apple/Companion.xcodeproj -scheme Companion-macOS -destination 'platform=macOS' -derivedDataPath .local/macos CODE_SIGNING_ALLOWED=NO -skipPackagePluginValidation build
docker compose -f deploy/compose.ui-test.yaml -p echo2-p4-ui down
```

## 未决与下一步

- 未使用真实模型 Key 或真实远程 MCP 服务，工具选择、真实 schema 兼容、模型效果及远端运维体验没有通过声明。SDK 的其他可协商协议版本未逐版验证。
- 未做真实 24 小时墙钟耐久、2 vCPU/4 GiB 容量、真实 iPhone/APNs、完整 Mac UI 自动化或完整无障碍验收；相关门槛保留在 T11–T13。
- 活动记录初始读取最近 100 条，数据库保留完整历史，历史分页尚未实现；后台预算按预留量而非货币费用控制。现实副作用无通用撤销能力。
- 下一阶段为 T11 可选通知中继、T12 自部署与备份恢复，尚未开始。真实数据迁移、备份恢复演练、发布与许可证决定仍按原门槛执行。
