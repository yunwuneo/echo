# P5 实施与验证记录

实施日期：2026-10-11（Asia/Shanghai）。用户“继续进行 P5 的实现”授权 T11–T12。全部自动验证使用合成剧情、模拟模型/工具/APNs 或专用本机 Docker 数据库；没有调用真实付费模型、现实工具或真实 APNs，没有创建云资源、公开部署、Git 提交或推送。

## 交付

| 任务 | 已实现                                                                                                                                                                                          | 验收边界                                                                                         |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| T11  | 完成消息后的持久通知队列、独立投递循环、可选中继、一次性邀请/challenge、加密票据、双端 topic 白名单、环境隔离、限流/撤销/过期/token 更新、P-256 JWT + HTTP/2 APNs、双端通知设置和认证后点击同步 | 真实 Apple 团队/签名环境待用户提供；模拟协议和模拟器不等于物理通知显示                           |
| T12  | 维护模式/运行锁、健康检查/诊断、带校验和的数据导出、标准数据库备份、空隔离库恢复、内容摘要验证、删除 ID 清单、epoch/重新配对、权限停用、事务密钥轮换、双架构镜像与升级回退步骤                  | 实测环境是本机 Docker Desktop Linux 容器；独立 Linux 主机、公网 HTTPS 和真实磁盘耗尽注入仍未验证 |

主要入口：`migrations/005_notifications_and_operations.sql`、`packages/server/src/modules/{notifications,operations,exports}`、`packages/push-relay/src`、`scripts/{ops,recovery-drill,verify-export}.mjs`、`apps/apple/Shared/{NotificationsView,OperationsView}.swift`。同步更新 TypeBox/OpenAPI、生成客户端适配、Apple entitlements、Compose 和 CI。完整行为、限额及操作步骤见 [通知指南](notifications.md)、[恢复指南](recovery.md) 与 ADR-018。

## 可靠性和隐私

- 业务消息与随机通知事件/投递记录同事务保存，外部请求不在事务中。通知有独立循环，不让中继超时占住聊天 outbox 调度；安静时段也抑制允许推进的后台剧情通知。
- 中继只接受明确字段，票据绑定实例/epoch/设备/topic/环境。邀请一次使用，challenge 十分钟，票据三十天；iOS/macOS 各自 topic 可加入同一中继白名单。APNs token 与业务投递凭据分别在中继/业务库加密，App 票据在 Keychain。
- 同 delivery ID 去重，APNs 发出前持久化；响应丢失或中继崩溃留 unknown，不自动重复未知投递。接受响应只标 accepted，不能标“设备已显示”。设备撤销、票据失效、源消息删除/失效都阻止旧入口继续工作。
- 活 API/Worker 持共享 advisory lock，轮换/恢复要求停服维护和独占锁。恢复不覆盖非空数据库，主密钥/校验失败保持隔离；换 epoch，撤销设备/旧通知，关闭自主/MCP 权限，将未完成 run 中断，工具执行未知保留人工核对。
- 较新删除 ID 清单能重新应用到旧备份，沿原有来源依赖清理派生数据。旧备份仍需独立保管/到期清理；没有最新删除记录时不能保证恢复全部遗忘意图。跨机器停源仍需操作者保证，恢复实例默认无自主权限。
- JSON owner archive 无应用凭据，原始导入保留字节与未知扩展；校验使用键排序后的 data，避免 Apple JSON 重编码使属性顺序变化。数据库备份单独保存，主密钥不包含其中。

## 验证证据

- 固定 Node **24.14.0 / npm 11.9.0** 与 PostgreSQL **17 / pgvector 0.8.2** 的完整集成测试 **100/100**（P1 24、P2 15、P3 16、P4 28、P5 17）；最终日志 `.local/p5-integration-final-100.log`。覆盖 P4→P5 迁移与重复迁移、消息事务/静默期/中继关闭、邀请与字段白名单、票据重放/设备绑定、iOS/macOS topic 绑定、token 轮换与失效、撤销、故障/失联 lease 恢复、重复/未知投递、限流、删除源入口、数据导出、密钥轮换成功/回滚、活进程锁、恢复隔离和删除清单。
- 同一源码镜像的 `lint`、`typecheck`、单元测试 **23/23**、`test:evals`、`contracts:check`、`build` 通过，日志 `.local/p5-node24-final.log`。中文固定合成词项集 recall@5 **80/80**，负例误召回 **0/20**，真实模型调用 **0**；不声明真实模型语义效果。
- Swift 共享包 **7/7**，`.local/p5-swift-final.log`；最终 macOS 构建通过，`.local/p5-macos-final.log`。iOS 随下面完整 UI 套件重新编译通过。
- iPhone 17 Pro Max 模拟器完整 UI 套件 **4/4**，日志 `.local/p5-ios-ui-final.log`，正常返回 `TEST SUCCEEDED`，结果 `.local/p5-ios-ui-final.xcresult`。覆盖 P3 记忆/导入、P4 审批/客户端关闭后自主回顾、P2 配对/离线待发/进程恢复，以及新增 P5 通知关闭时可用、诊断、系统选择器实际保存、认证后冷启动原文跳转。P5 路由使用 DEBUG 注入相同事件 envelope，不宣称真实 OS/APNs 投递。
- 已查看 `.local/p5-ios-final-artifacts/` 的通知、数据与诊断、原文路由截图，文本/按钮/状态可读。模拟器实际保存的 JSON 已复制到 `.local/p5-export-verified.json`，`scripts/verify-export.mjs` 验证成功，日志 `.local/p5-export-verification.log`；确认 Swift 重编码后归档校验仍正确。

- 完整真实备份恢复已执行两轮。第二轮报告 `.local/p5-recovery-90e1e063/report.json`，日志 `.local/p5-recovery-final.log`：全新 Linux 容器健康启动、数据库重启、停源备份与校验、损坏归档拒绝、错误主密钥拒绝、非空目标拒绝、八类业务表数量/摘要一致、较新删除记录重放、模型凭据实际解密、显式切换与新配对、既有 P4 镜像 API/Worker/快照兼容并切回 P5。没有读取真实数据；专用容器和卷已清理。
- arm64 生产镜像 `echo2-server:p5-local` 构建并用于上述恢复；amd64 镜像 `echo2-server:p5-amd64` 构建成功，日志分别 `.local/p5-runtime-final-build.log`、`.local/p5-amd64-final-build.log`。amd64 是本机仿真构建，非物理 x86 主机性能验收。
- 固定 Node 24 的单元用例已覆盖 APNs JWT 真签名验签、本机 HTTP/2 请求/固定载荷、sandbox/production 路由、410/429/topic 错误与配置拒绝；无真实 APNs 网络请求。

早期失败保留在 `.local/`，包括撤销队列缺少 owner 外键（已修复）、Swift 访问/视图作用域编译问题（已修复）、测试对多层“完成”和系统文件选择器按钮的定位问题。关闭按钮增加稳定标识，文件保存等待选择器关闭；P5 路由用独立持久合成消息验证，不依赖其他用例的聊天或输入法状态。P4 的 SSE 用例在并行重型验证期间有一次失败，最终在不并发重型构建的条件下完整重跑 **100/100** 通过；不把失败运行计入通过结果。Xcode 在部分失败运行后卡在报告收集，已按精确 PID 终止本次创建的测试进程，未停止其他已有服务。

## 复现

```sh
docker build --target development -t echo2-server:p5-check .
docker run --rm echo2-server:p5-check sh -c 'npm run lint && npm run typecheck && npm test && npm run test:evals && npm run contracts:check && npm run build'
docker compose -f deploy/compose.test.yaml -p echo2-p5-tests up --build --abort-on-container-exit --exit-code-from tests
docker compose -f deploy/compose.test.yaml -p echo2-p5-tests down
docker build -t echo2-server:p5-local .
docker build --platform linux/amd64 -t echo2-server:p5-amd64 .
node scripts/recovery-drill.mjs --synthetic
# 可选：本机已有上一版本镜像时验证兼容回退。
node scripts/recovery-drill.mjs --synthetic --previous-image=echo2-server:p4-local
swift test --package-path apps/apple/Packages/CompanionCore
```

UI 联调原 3012 被已有服务占用，本次使用独立 loopback 3015；未关闭该已有服务。最终验证后已清理本轮 `echo2-p5-tests` 与 `echo2-p5-ui` 的专用容器和网络。测试环境、入口和签名模拟器命令如下，其他机器替换实际模拟器 UUID/结果目录。失败与成功 xcresult 目录不能复用。

```sh
ECHO_UI_PORT=3015 docker compose -f deploy/compose.ui-test.yaml -p echo2-p5-ui up -d --build
xcodebuild -project apps/apple/Companion.xcodeproj -scheme Companion-iOS -destination 'platform=iOS Simulator,id=34F8DBDA-87C9-4518-960E-56D6A03321CB' -derivedDataPath .local/ios -resultBundlePath .local/p5-ios-ui-final.xcresult ECHO_UI_BASE_URL=http://127.0.0.1:3015 CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=- -skipPackagePluginValidation test
ECHO_UI_PORT=3015 docker compose -f deploy/compose.ui-test.yaml -p echo2-p5-ui down
```

## 未决与下一步

- 用户已表示有 Apple 团队/Bundle ID/签名设备，稍后提供。届时继续 T11 真机矩阵，记录前后台、锁屏/强退、离线/专注、拒绝权限、环境错误、token 更新、点击拉取；不要求在聊天中发送私钥。
- 未验证独立新 Linux 主机、公网 TLS、真实磁盘满、真实远程模型/MCP、24 小时墙钟耐久、容量和完整 macOS UI/无障碍；继续按既有门槛保留，不提前将 T13 通过。
- 中继默认未部署，单环境最多十个 topic，邀请由中继 CLI 签发，没有公共开放注册。APNs 临时错误或未知响应可能漏通知，业务同步仍可找回消息。业务配置支持一个中继 origin；测试与生产应分开部署。
- JSON owner archive 限三十二 MiB，无公开导入/恢复端点；整实例恢复需标准备份。备份有停服窗口；中继库密钥原地轮换 CLI 尚未提供，业务主密钥轮换覆盖全部业务凭据。
- P6（T13）未开始，需后续授权。许可证与发布方式仍按原决定待定。
