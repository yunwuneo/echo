# 首版验收追踪

更新：2026-10-11。下表是可定位的测试路径，不以路径存在判定通过。本轮实际命令/结果集中在 [P6 报告](p6-report.md)；历史物理与模拟器证据分别保留在各阶段报告。`自动路径` 只表示确定性协议/数据库覆盖，不能替代真实模型效果、物理设备或真实远端服务。

| ID  | 主要自动路径                                                                       | 额外证据/未决                                   |
| --- | ---------------------------------------------------------------------------------- | ----------------------------------------------- |
| A01 | `p1.test.ts` pairing/expired/brute force                                           | Apple 配对在 UI 用例                            |
| A02 | `p1.test.ts` revoke/refresh/SSE                                                    | 真机设备撤销交互仍需物理矩阵                    |
| A03 | `p1.test.ts` logs/Key；`p5.test.ts` export/relay                                   | [数据清单](privacy-data.md)                     |
| A04 | `p1.test.ts` stable 202/conflicting retries/outbox                                 | 无重复业务提交                                  |
| A05 | `p1.test.ts` HTTP disconnect；`p4.test.ts` clients closed                          | P4/P5 模拟器离线纵向记录                        |
| A06 | `p1.test.ts` partial/malformed/SIGKILL                                             | 真机任意网络组合未穷尽                          |
| A07 | `p1.test.ts` world order；`p2.test.ts` sync edits                                  | Apple 双端证据见 P2，P6 HTTP 容量不冒充 UI 延迟 |
| A08 | `p2.test.ts` explicit relay/member limits                                          | UI 配对群聊用例                                 |
| A09 | `p2.test.ts` private room/lore/state；`p3.test.ts` evidence/vector                 | 权限先过滤；不能用最终回答代替                  |
| A10 | `p2.test.ts` world instances；`p3.test.ts` cross-world recall                      | S06/S12 真实剧情评分待验                        |
| A11 | `p2.test.ts` correction/revision/stale result                                      | S03/S19 人工评分待验                            |
| A12 | `context.test.ts` core/history/lore budgets                                        | 实际供应商上下文差异待验                        |
| A13 | `p3.test.ts` RE2/time effects/rollback                                             | 批量 activation 查询由同套回归保护              |
| A14 | `p3.test.ts` JSON/PNG/import/unknown fields                                        | 仅声明兼容子集                                  |
| A15 | `p3.test.ts` sources/dedup/claims                                                  | 自动提取真实质量待人工核对                      |
| A16 | `p3.test.ts` forgetting/erasure/late jobs；`p4.test.ts` tool erasure               | P6 分块级联；离线设备重连后重建                 |
| A17 | `p3.test.ts` lexical/embedding failure                                             | 100 条合成检索集合                              |
| A18 | `p3.test.ts` embedding dimension/version                                           | 真实嵌入服务待验                                |
| A19 | `p4.test.ts` quiet/user activity/skip                                              | 24h 墙钟运行看最终报告                          |
| A20 | `p4.test.ts` defaults/budget/autonomy limits                                       | P6 soak 不发送前台输入                          |
| A21 | `p4.test.ts` queued revocation/late result                                         | 关闭后重开仍拒绝旧修订                          |
| A22 | `p4.test.ts` recap/source                                                          | 无模型摘要；UI 跳原文用例                       |
| A23 | `p4.test.ts` default grants/scopes                                                 | 真实远端 MCP 待验                               |
| A24 | `p4.test.ts` write approval/schema/denial                                          | UI 审批用例                                     |
| A25 | `p4.test.ts` unknown/dispatch crash/reconciliation                                 | 不承诺外部恰好一次                              |
| A26 | `p4.test.ts` malicious result/redaction；`context.test.ts` suggestions             | S15/S16 真实模型评分待验                        |
| A27 | `security.test.ts`；`p4.test.ts` mixed DNS/SSRF/redirect                           | 仅按连接精确 IP 许可                            |
| A28 | `p5.test.ts` no relay/outage/quiet                                                 | 真机 APNs 仍待签名环境                          |
| A29 | `p2.test.ts` snapshot/retention；Swift `SyncTests`                                 | P6 跨块/旧快照/批量缓存；真机大库待验           |
| A30 | `p5.test.ts` restore/epoch/ledger；`recovery-drill.mjs`                            | P5 实际隔离恢复；独立主机/物理磁盘故障待验      |
| A31 | `p2.test.ts` regeneration；`p3.test.ts` derived invalidation；`p4.test.ts` effects | 含工具的运行不透明重生成                        |
| A32 | `p3.test.ts` old editor fields；P5→P6 migration；Swift capability check            | P5 快照格式/回退读取保留                        |

文件默认位于 `tests/integration/`，逻辑测试位于 `tests/unit/`。Apple 用例位于 `apps/apple/UITests/CompanionUITests.swift` 与共享包 Tests。性能和评分测试不混入快速单元用例；真实模型调用必须显式选择配置与预算。

仍需完成的发行门槛：至少两个真实模型配置及人工评分、物理 iPhone/Mac 通知矩阵、独立 Linux HTTPS/磁盘故障、iOS 大字体/深色修复复测、完整 macOS UI/VoiceOver/键盘体验、候选运行镜像、完整 24h 耐久结果、许可证与分发渠道。Docker 失联后按用户决定保留结果及源码包，不重启；残留 soak 报告未通过。保持 T13 为进行中。
