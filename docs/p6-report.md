# P6 实施与综合验证记录

日期：2026-10-11（Asia/Shanghai）。用户已明确授权继续 P6/T13。当前为 **0.6.0 本地候选**，T13 综合发行验收仍进行中；缺失的真实环境结果不能用模拟协议或构建替代。

## 实现

- 006 迁移：固定水位快照新增每 500 条的索引分块，兼容旧快照和 P5 回退；遗忘/删除仍级联失效。世界书状态从逐条查询改为一次关联，保持房间/角色/版本范围。
- Apple 缓存按唯一键读取游标；全量重建避免逐条查旧记录，并回归批量替换、其他命名空间与草稿保留。
- 专用容量/24h 耐久工具：10 世界、80 角色、10 万消息、1 万记忆、2 千世界书；总限额 2 CPU/4 GiB；真实持久队列、模拟模型、资源与延迟报告。
- 100 条合成记忆查询及 20 段三轮中文剧情；真实模型选择/预算预留/三次重复/人工四维评分工具。真实 Key 未提供时只做离线编译，无真实质量通过声明。
- [验收追踪](acceptance-trace.md)、[能力兼容](compatibility.md)、[隐私清单](privacy-data.md)、[验证/交付指南](p6-usage.md)，以及带逐文件哈希、schema/版本/未通过门槛的本地候选包。

## 证据

- 固定 Node 24.14.0 / PostgreSQL 17+pgvector 0.8.2 集成 **102/102**：`.local/p6-integration.log`。新增跨快照块/旧会话/级联删除与 P5→P6 中断迁移；P1–P5 全部回归通过。
- 同一集成镜像 `lint/typecheck/单元25项/test:evals/contracts:check/build` 全通过：`.local/p6-node24.log`。离线记忆 recall@5 80/80、负例误召回 0/20；20 段三轮共 60 次剧情编译，模型调用 0、质量未评分。
- Swift 包 **8/8**：`.local/p6-swift.log`。另一次十万条合成记录的内存 SwiftData 加载+解码 **6.89s**，完整替换/命名空间/草稿断言通过，`.local/p6-swift-capacity.log`。这不是物理 iPhone 持久磁盘速度。
- 十分钟容量完整通过：`.local/p6-benchmark/capacity.json` / `.local/p6-capacity-final.log`。70/70 前台运行完成、140 次双 HTTP 客户端观察，9 次后台记忆请求（保守预留输入49095、输出9216），全部限额检查通过。上下文每次 **7 条 SQL**；162122 条快照记录分325页读取，用时 **0.75s**，创建 **3.46s**。

| 指标                       | p95      | 目标                                   |
| -------------------------- | -------- | -------------------------------------- |
| 持久化 ACK                 | 49.05ms  | ≤500ms                                 |
| 提交至 HTTP 客户端观察上界 | 361.63ms | ≤2000ms                                |
| 检索与上下文组装           | 22.70ms  | ≤300ms                                 |
| 快照单页                   | 3.67ms   | 单独报告                               |
| 入队至模拟模型完成并被观察 | 3626ms   | 包含排队和模拟模型，不作为自身开销 SLA |

容量运行镜像身份为 `sha256:8fa4c89ff1b7d1d2f2528bdcc1447773dbb71666f594e0cac10dffe6fee0ccd7`。最大进程 RSS 和数据库增长以 JSON samples 为准；服务与测试客户端同进程，RSS 包含观察端和模拟模型。没有用空库微测试替代指定历史数据规模。

Apple UI：首次 iOS 大字体无障碍测试发现状态文本裁切，截图同时暴露配对页说明裁切（`.local/p6-ios-a11y.log`、对应 `.xcresult` 与 `.local/p6-ios-a11y-artifacts/`）。已改为可换行状态文本、可滚动分组配对表单，并补充 DEBUG 深色模式测试入口。修复代码在 iOS 测试构建中编译；macOS 构建通过（`.local/p6-macos-build-final.log`）。修复后的 iOS UI 复测在测试准备阶段因 `127.0.0.1:3016` 夹具服务拒绝连接而失败，尚未验证修复效果或深色外观（`.local/p6-ios-a11y-fixed.log` / `.xcresult`）。macOS UI 尝试到达配对流程但等待房间失败，原因未确认（`.local/p6-macos-ui.log` / `.xcresult`）；签名重试另遇 provisioning 要求（`.local/p6-macos-signed.log`）。这些结果均不计为 UI 验收通过。

优化前基线 `.local/p6-benchmark/baseline.json`：同规模合成数据，上下文每次 207 条 SQL；首次三页的分页耗时 p50 76.4ms、最大 191.8ms。只有三页样本，不把该 p95 作为稳定分布。基线快照创建 7.44s。

本机环境：Docker Desktop Linux arm64 VM，分配 10 CPU/约 7.75 GiB，overlayfs；测试应用与 DB 各限 1 CPU/2 GiB。此为资源受限容器实测，不是独立物理 2 核 Linux 主机、公网 TLS 或 Apple UI 延迟承诺。

## 本轮收尾与保留结果

Docker 引擎失联后，用户明确要求“不重启，保留已完成结果和候选源码包”。已停止本次挂起的 Docker 构建/版本查询客户端，没有重启 Docker，也没有停止或清理容器。P6 专用 UI/soak 容器的实际状态无法确认；已有容器和专用测试卷保留，后续恢复环境时先核对状态与旧证据。

- `.local/p6-benchmark/soak.json` 保留原始 `status=running`，最后更新时间为 2026-10-11 14:36:01（Asia/Shanghai），最后运行采样约 70.11 秒，未形成完成报告。它表示中断后无法验证的残留状态，不表示现在仍在推进；24 小时门槛未通过。收尾说明另存 `.local/p6-benchmark/soak-interruption.json`，不改写原始数据。
- `echo2-server:0.6.0-local` 运行镜像构建未完成，不能用已通过容量测试的镜像替代最终候选镜像身份。
- 已通过的日志、容量 JSON、失败的 UI 日志/截图/xcresult 均保留在 `.local/`；先前缺少后台任务的容量尝试保存在 `capacity-incomplete-no-background.json`，不计入通过结果。
- 最终源码候选通过 `npm run release:prepare` 生成到 `.local/releases/echo-0.6.0-candidate-<内容指纹>.tar.gz`，附归档校验和与逐文件哈希清单。源码包包含实施报告和验收限制，原始本机日志留在工作区，不随源码打包；`release_ready=false`。生成记录见 `.local/p6-release-final.log`，归档校验记录见 `.local/p6-release-verification.json`。

## 已知限制与后续门槛

- 尚无两种真实模型配置/付费测试预算与人工评分，无真实远端 MCP 兼容证据；工具不会自动选择服务或读取生产 Key。
- 用户此前表示签名信息稍后提供；物理 iPhone/Mac APNs、锁屏/强退/离线/专注/权限矩阵仍待环境。模拟器不会标为真机。
- 独立 Linux 主机、公网 HTTPS、物理磁盘满仍未验证；P5 的隔离备份恢复证据继续有效，不能扩大成异地主机测试。
- Docker 恢复后仍需重跑完整 24h 墙钟测试、复测 iOS 大字体/深色界面并完成候选镜像构建。完整 macOS 无障碍/VoiceOver/键盘与物理设备大库仍需补齐；本轮按用户决定保留状态，不重启 Docker。
- 快照创建仍会物化全量内容；十分钟有效期内为回退兼容临时同时保存原 records 和分块。Apple 缓存仍全量解码，不能宣称任意规模可用。
- 许可证、公开源码范围及分发方式仍由用户决定；本轮不公开发布、不部署、不提交/推送 Git。

执行命令见 [P6 验证指南](p6-usage.md)。后续从此报告的未通过门槛继续，无需再次请求 P6 阶段授权。
