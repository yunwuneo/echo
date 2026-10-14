# Echo Dock 与 UI/UX v2 实施记录

日期：2026-10-11（Asia/Shanghai）。依据用户提供的 `echo-design-spec-v2.md` 第 8、9 章及 Dock 浅色、收起、深色效果图实施，承接 [首轮 UI/UX 优化](design-refresh.md)。本轮实现、分批回归、原生截图和仍未覆盖的系统矩阵记录如下。没有提交、推送或部署。

## 范围与命名

用户明确要求将界面中的“世界 / 世界书”统一为“TA 的设定 / 设定集”。服务端领域、接口、数据库与代码中的 `world` / `lore` 标识保持不变；此命名调整不改变多角色、共享世界、群聊、独立角色知识、无人剧情和 MCP 的首版范围。设计文档中的“一对一情侣应用”不是本次缩减产品范围的授权。

效果图用于导航、状态与外观参考。没有真实数据来源时，不添加未读数量、已读标记、在线点、相识天数、纪念日、照片或精选对话等示例内容。回忆来自已同步的记忆与原始消息，不把示例图的文案存入业务数据。

## 已实现的界面与兼容策略

- iOS 使用系统 `TabView`，提供“聊天 / 回忆 / TA / 我”四个入口；聊天详情隐藏 tab bar，返回后恢复。聊天列表支持搜索，私聊排在群聊前，同类会话按最近消息排序；末条消息摘要按房间一次遍历聚合，不在排序比较器内反复扫描全部历史。
- “回忆”按真实 `valid_from` 日期分组并标明所属故事，未确认与冲突记忆保留提示；页面按缓存快照重新呈现时排除 `valid_to` 已到期的内容，未增加独立时钟定时刷新。详情按记忆 ID 实时读取缓存，修正、删除、遗忘同步后不会继续展示被选中时的旧正文；已选故事被删除后清除失效筛选，仍能查看其他故事的回忆。
- 空 `audience_actor_ids` 的回忆标为“仅你可见”，详情称为“你的记录”；不把仅主人可见内容说成角色已经知晓。claimed 提示为“这件事被提到过 · 还未确认”，不凭状态字段断言由哪位角色说出。
- “TA”按世界内角色实例切换，显示所属设定；私聊入口同时匹配角色实例与世界，人物模板只在修订与实例固定版本一致时展示。主动设置弹层固定打开时的世界，角色被删除后即使资料页切换到另一角色，也不会把原草稿的保存目标换到另一世界。相同模板在不同世界的经历不合并。
- “我”集中服务器与配对、通知、外观和高级管理入口；设定集、预算、MCP、导入/导出、记忆来源与诊断仍可达。macOS 沿用侧栏与聊天详情，不增加底部 Dock。
- 切换服务器命名空间会清空旧聊天路径、通知来源与弹层；当前房间同步删除后返回列表。通知仍先核对实例与 epoch，经服务端解析并同步后进入原文，不通过界面标签绕过权限检查。

| 运行系统        | 系统导航                            | 实时状态位置与处理                                                                                                                               |
| --------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| iOS 26.1 及以上 | 原生 Liquid Glass tab bar，下滑收起 | 常规字号使用 `tabViewBottomAccessory(isEnabled:content:)`；无状态时禁用，inline placement 使用短文案；辅助功能字号改为列表顶部可换行 QuietStatus |
| iOS 26.0        | 原生 Liquid Glass tab bar，下滑收起 | 聊天列表顶部 QuietStatus；不切换整棵 TabView 的条件分支，不挂空 accessory                                                                        |
| iOS 18–25       | 系统普通 tab bar                    | 聊天列表顶部 QuietStatus；不模拟玻璃或添加自定义模糊                                                                                             |
| macOS 15 及以上 | 原生侧栏与工具栏                    | 保留聊天状态及行动确认入口，不使用 iOS 底部 accessory                                                                                            |

iOS 26.0 的列表状态是对参考伪代码的兼容调整：以实时状态的有无在外层切换两种 TabView 结构，会重建页内状态；稳定挂载空 accessory 又存在占位风险。因此仅在提供 `isEnabled` 的系统使用底部状态条。本机 iOS 27 SDK 的 SwiftUI 接口明确标注：无 `isEnabled` 重载始于 iOS 26.0，带 `isEnabled` 重载始于 iOS 26.1。接口参考：[Apple `tabViewBottomAccessory(isEnabled:content:)`](<https://developer.apple.com/documentation/swiftui/view/tabviewbottomaccessory(isenabled:content:)>)、[Apple inline placement](https://developer.apple.com/documentation/swiftui/tabviewbottomaccessoryplacement/inline)。版本分支已落地，不等于所有历史系统已完成运行验证。

最大辅助字号实测发现，系统底部 accessory 容器的高度约束会裁切放大后的文字。当前对全部辅助功能字号（`dynamicTypeSize.isAccessibilitySize`）禁用底部 accessory，在聊天列表顶部显示可换行状态；常规字号仍使用系统 accessory。状态通过顶部 `safeAreaInset` 预留完整高度，避免动态插入列表行时旧滚动位置使其被搜索栏遮挡；辅助字号的搜索提示缩短为“搜索”。此调整保持系统 tab bar，不缩小用户选择的字体。最终最大字体用例通过标签描述与文字裁切审计，但不等于完整 VoiceOver 验收。

## 类型化状态与真实数据边界

`CompanionCore/ChatModels.swift` 新增 `ChatMessage`、`MessageRole`、`MessageStatus`、`ChatRun`、`RunState`，从原有 `Record` 投影。未知角色和状态保留为 `unknown`，不冒充完成、角色回应或活动中的运行；界面不显示原始未知协议值。`MessageBubble` 使用类型化消息，正常完成仍保持安静，复制、引用和申请换回答留在上下文菜单。换回答仍接受服务端最后一轮及副作用校验。

`LiveStatus` 仅从当前连接已同步的运行、消息、角色、房间和动作记录派生：

- 真实 streaming 角色消息且运行仍在执行时，才显示该角色正在输入；没有可确认发言者时显示会话正在准备回应，不把上一个群聊发言者或第一个成员当作当前发言者。
- 工具动作已批准或执行中时，旧 streaming 消息不用于假装正在输入。待批准需要动作未过期且运行正在等待；外部结果未知即使运行已取消，仍显示需要核对结果。
- 离线缓存、排队、完成和失败运行不冒充实时输入。列表按实际时间倒序，以稳定 ID 处理同一时刻；多项只显示当前一项及剩余数量。无未读协议，不生成 badge 数字。
- `ChatPresentation` 显式解析 ISO 时间中的时区；测试发现并修复了同一瞬间的 `+08:00` 与 `Z` 表达排序不同的问题。错误、失效和未知状态消息不再被连续分组隐藏。

接口与迁移：没有新增 REST、同步实体、缓存 schema 或数据库迁移；服务端仍是业务数据与权限的权威来源。

## 设计系统、文案与检查

颜色使用 `Shared/DesignSystem/EchoColors.xcassets` 命名资源，提供浅色、深色与增强对比度变体；暮玫增强对比色为浅色 `#8A463F`、深色 `#D08A80`。`EchoColor`、`EchoFont`、`EchoSpacing`、`EchoMotion` 集中维护视觉参数。底部玻璃由系统提供，不给 tab bar 或 accessory 叠自定义背景、描边或阴影。

中文可见文案接入 `Shared/Localizable.xcstrings`（628 个源文案条目）；最终逐项核对两端 App 内编译后的中文资源，键和值与 catalog 一致。Core 派生展示文案通过主应用 bundle 本地化，协议值和领域标识不翻译。状态合并为单个可访问按钮；常规字号使用长短文案，辅助功能字号的列表状态允许换行。减弱动态效果时输入点静止，降低透明度交给系统导航材质处理。完整辅助功能效果仍以实测矩阵为准。

新增 `scripts/lint-apple-ui.sh`，入口 `npm run lint:apple-ui`，加入 Apple CI。检查 Shared 视图中的裸颜色、系统蓝紫、裸字号/圆角、仿玻璃 material、tab bar 自定义背景，以及聊天主路径的技术文案；排除集中定义 token 的 DesignSystem。脚本区分 `rg` 没有命中与执行错误，缺工具或检查失败不会被当作通过。此检查不是逐项视觉验收，也不保证识别所有跨行 Swift 写法。

## 验证证据与当前结论

| 项目             | 证据                                                                                 | 结论                                                     |
| ---------------- | ------------------------------------------------------------------------------------ | -------------------------------------------------------- |
| Swift Core       | `.local/dock-v2/swift-final.log`：全包 28 项，新增 10 项 LiveStatus/类型化消息测试   | 通过                                                     |
| iOS / macOS 构建 | `.local/dock-v2/ios-resource-final.log`、`.local/dock-v2/mac-final.log`              | 最终代码构建通过                                         |
| 类型与静态检查   | TypeScript、npm lint、Apple UI lint、Swift 格式、`git diff --check`                  | 通过；不替代视觉验收                                     |
| iOS 界面回归     | 下表去重 13 个场景；iPhone 17 Pro Max 模拟器，iOS 27                                 | 分批复测通过                                             |
| 最大辅助字号     | `ios-ax-final.log/.xcresult`，深色、辅助字号最大档、状态点按进入聊天，描述与裁切审计 | 通过；未完成全页 VoiceOver 人工检查                      |
| 降低透明度       | `ios-accessibility.log/.xcresult` 中 `testDockSystemReducedTransparency`             | 实际打开系统开关为 1，在 Echo 截图与审计，结束恢复原值 0 |
| macOS 原生手测   | `.local/dock-v2/mac-smoke.md` 与截图                                                 | 侧栏/滚动/右键菜单/设置/外观/长表单操作通过              |
| 历史系统兼容     | availability 分支与 SDK 标注核对                                                     | 无 iOS 18–26.0 runtime，尚未运行验证                     |

分批回归只计以下已通过的用例，不能把包含早期失败的整份日志称为全套通过。每个日志旁保留同名 `.xcresult`：

| 最终有效记录（均在 `.local/dock-v2/`） | 通过的测试方法（省略共同 `test` 前缀）                                                                                                                                 | 数量 |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| `ios-core-v2.log`                      | `DockApprovalAccessoryOpensRealApproval`、`DockLiveStatusOpensConversationAndDisappears`、`PairChatOfflineRestartAndRejoin`、`UIRefreshDarkChat`、`UIRefreshLargeText` | 5    |
| `ios-follow.log`                       | `DockOpenMemoryClosesAfterRemoteForgetting`、`DockScrollKeepsLiveStatusAccessible`、`DockSwitchServerClearsChatNavigation`                                             | 3    |
| `ios-final.log`                        | `P5NotificationSettingsExportAndColdStartRoute`                                                                                                                        | 1    |
| `ios-accessibility.log`                | `DockSystemReducedTransparency`                                                                                                                                        | 1    |
| `ios-verified.log`                     | `DockMemoriesShowSyncedSource`、`DockTabsSearchAndDetailNavigation`                                                                                                    | 2    |
| `ios-ax-final.log`                     | `DockDarkLargeTextReducedMotion`                                                                                                                                       | 1    |

这轮测试实际发现并修复了：回忆行空白区域不响应点按、返回搜索结果后键盘重新弹出并遮住 Dock、旧记忆详情残留、辅助字号状态条与搜索提示裁切。原生收起后的 tab bar 需要先展开再选择其他页，测试助手已按系统行为调整。早期 Xcode 测试中断、选择器失败及可选诊断采集超时记录仍保留，不计成功；`ios-core-v2` 中较早的最大字体用例只审计描述，已被最后一条裁切审计结果替代。

Mac 手测在 16 个合成会话下滚至侧栏末尾，连接入口固定可见且可打开设置；测试了深浅色切换、设定入口和长中文主动设置表单，未保存表单草稿。早期窗口截图裁掉了下沿；使用系统窗口排列后取得完整截图，临时测量代码已删除，没有据此修改最小窗口尺寸。最小窗口、悬停按钮与 VoiceOver 音频未单独验证。

Core 已覆盖：未知枚举回退、仅完成角色回复允许申请换回答、失败/跨房间不合并、群聊真实发言者、无发言者及执行动作不伪装输入、离线/排队/终态安静、审批过期/取消、取消后的未知结果核对、等价时区与稳定排序。全部夹具为合成数据。

复现 Core 和静态检查：

```sh
CLANG_MODULE_CACHE_PATH=/tmp/echo-v2-clang-cache \
SWIFTPM_MODULECACHE_OVERRIDE=/tmp/echo-v2-swift-cache \
swift test --package-path apps/apple/Packages/CompanionCore --disable-sandbox --skip-update
npm run lint:apple-ui
git diff --check
```

受限写目录下将 Swift 模块缓存指向 `/tmp`。最终日志包含 CoreData 通知权限警告，28 项测试实际通过。

截图全部来自合成业务数据、模拟模型与 MCP 服务；没有真实用户聊天、模型 Key 或真实模型质量结论。测试结束已退出两端测试 App，停止 3018 合成服务及 55419 隔离数据库，未改动 Docker。系统降低透明度恢复为 0，增强对比度恢复为 disabled。

界面与参考图的已知差异：本机 iOS 27 的普通首页在冷启动后仍采用居中 inline 导航标题，代码虽请求 `.large`，本轮没有通过自绘标题替代原生导航；也没有为复刻效果图添加没有业务来源的纪念日、照片或未读点。

| 画面                 | 截图                                                                                                                                                                                                                                                                                                       |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 系统 Dock 与实时状态 | [空闲](dock-v2/ios-idle.png)、[浅色首页](dock-v2/ios-home-light.png)、[运行](dock-v2/ios-live-status.png)、[下滑收起](dock-v2/ios-dock-inline.png)                                                                                                                                                         |
| 行动确认             | [状态入口](dock-v2/ios-approval-accessory.png)、[确认页](dock-v2/ios-approval.png)                                                                                                                                                                                                                         |
| 回忆与资料           | [回忆](dock-v2/ios-memories.png)、[原话](dock-v2/ios-memory-source.png)、[遗忘后关闭](dock-v2/ios-memory-forgotten.png)、[TA](dock-v2/ios-partner.png)、[我](dock-v2/ios-profile.png)                                                                                                                      |
| 系统降低透明度       | [深色实测](dock-v2/ios-reduce-transparency.png)                                                                                                                                                                                                                                                            |
| 辅助功能             | [深色最大字号](dock-v2/ios-home-dark-ax.png)、[系统增强对比度](dock-v2/ios-high-contrast.png)                                                                                                                                                                                                              |
| macOS                | [侧栏](dock-v2/mac-sidebar.png)、[滚动至末尾](dock-v2/mac-sidebar-scrolled.png)、[原生菜单](dock-v2/mac-sidebar-menu.png)、[浅色设置](dock-v2/mac-settings-light.png)、[深色设置](dock-v2/mac-settings-dark.png)、[高级](dock-v2/mac-settings-advanced.png)、[长表单末尾](dock-v2/mac-autonomy-bottom.png) |

## 未决与下一步

完整 VoiceOver、iOS 18–26.0、小屏/iPad/横屏、最小 Mac 窗口与全页外观/最大字体矩阵尚未覆盖。增强对比度已通过真实系统开关截图检查并恢复，尚无逐像素对比度比值审计。减弱动态效果的系统读取和静止实现已保留；本轮最大字体用例打开了 DEBUG 减弱动态标记，但 hold 夹具处于“准备回应”，不能把它当作输入点动画逐帧验证。最后审查固定主动设置作用域、清除失效故事筛选的修复已编译，跨设备删除角色时保持草稿目标仍需专项 UI 用例。静态的一次遍历消息摘要不等于大历史数据性能 SLA。

本次是 T05 的 UI 修订与 T13 局部验证，不改变 T13 进行中的状态；真实模型、物理通知、发行签名、独立 Linux 与长期耐久等原有发布门槛继续保留。
