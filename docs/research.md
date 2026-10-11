# 竞品与平台约束调研

调研日期：2026-10-09。仅阅读公开源码、官方产品描述、官方平台文档；未安装或运行竞品。

## 1. 证据边界

- Kelivo：GitHub `master` 固定到 `4742d2e2861d963a65d8f642eeba9782566cd426`。当前源码不等于商店已发行版本。
- SillyTavern：按用户“酒馆”理解为 SillyTavern，`release` 固定到 `06bde939fb1e9c4c8d8641d810f0a916b5bce127`。
- Aru：用户确认 [App Store id6781350361](https://apps.apple.com/cn/app/aru/id6781350361)；阅读当时显示的 1.2 版说明及官网。没有获得源代码，不能确认内部数据库、框架、队列或算法。
- MCP 社区扩展：`bmen25124/SillyTavern-MCP-Client` 固定到 `04fdfe4410d59534ab379e9741e1277a95f6d384`。这是社区扩展证据，不代表酒馆核心原生实现。

## 2. 横向结论

| 能力 | Kelivo | SillyTavern | Aru |
| --- | --- | --- | --- |
| 架构 | Flutter/Dart 客户端，Provider，SQLite/Drift 等本地存储；直接连接模型 | 浏览器 JS 前端 + Node/Express；聊天 JSONL 存服务端用户目录；大量编排在浏览器 | 官方称个人 AI 协作平台，本地数据、用户配置模型，有 Aru Host 电脑协作 |
| 人设 | Assistant 系统提示词、预设消息、采样、工具与记忆配置 | 角色卡、用户 Persona、群组场景和多种发言策略 | 可配置协作者、独立模型、房间与预设；内部实现未知 |
| 世界书 | 关键词/正则、常驻、深度/位置、优先级、sticky/cooldown/delay | 递归激活、关键词与组合规则、预算、位置、概率和定时效果等 | 版本说明有世界书继承与协作者独立触发方式；算法未知 |
| 记忆 | Gatekeeper → Extract → Smart Add → Distiller；全局/助手作用域 | 摘要扩展 + 向量检索扩展；不能等同于统一事实与关系记忆系统 | 官方说明结构化记忆、跨对话检索、语义索引、日记和原文来源 |
| 主动能力 | Android/桌面定时执行；iOS 源码采用预生成和本地通知 | 已核实群聊自动模式在前端 setInterval 中运行 | 版本说明有主动规则和 Host 任务恢复；无法验证所有客户端离线时的行为 |
| MCP | Streamable HTTP、SSE、STDIO、OAuth、按工具审批 | 已核实社区客户端扩展 + 服务端插件路径 | 官网明确支持启用的 MCP 工具；传输和权限算法未知 |
| 对本项目的意义 | 借鉴人设配置、记忆整理、世界书和工具体验 | 借鉴角色生态、世界书规则和群聊控制 | 借鉴持续上下文、回顾与来源查看、任务状态体验 |

结论：可以复用这些设计思想和开放格式，但本项目必须建立自己的云端权威状态及无人值守执行流程。SillyTavern 能部署在服务器，其数据也可位于服务器；不能把它错误描述为“所有数据都在浏览器本地”。区别在于当前核实的主要编排依赖前端运行。

## 3. Kelivo 实现细节

### 架构与角色

- [README](https://github.com/Chevey339/kelivo/blob/4742d2e2861d963a65d8f642eeba9782566cd426/README_ZH_CN.md) 明确无自己的账号体系，对话/设置/文件在本地，WebDAV/S3 是备份能力。
- [pubspec.yaml](https://github.com/Chevey339/kelivo/blob/4742d2e2861d963a65d8f642eeba9782566cd426/pubspec.yaml) 核实 Flutter、provider、drift/sqlite3、Hive 及本地 mcp_client 依赖。不能仅凭旧资料把当前存储统一写成 Hive。
- [assistant.dart](https://github.com/Chevey339/kelivo/blob/4742d2e2861d963a65d8f642eeba9782566cd426/lib/core/models/assistant.dart) 将系统提示词、模型、MCP、记忆配置、预设消息等绑定到 Assistant。

### 世界书

- [world_book.dart](https://github.com/Chevey339/kelivo/blob/4742d2e2861d963a65d8f642eeba9782566cd426/lib/core/models/world_book.dart) 定义关键词、正则、常驻激活、扫描深度、注入位置/角色、优先级、sticky/cooldown/delay。
- [world_book_activation.dart](https://github.com/Chevey339/kelivo/blob/4742d2e2861d963a65d8f642eeba9782566cd426/lib/core/services/world_book_activation.dart) 扫描聊天消息，以真实消息数计算效果；使用历史内容哈希检测回退或修改，稳定排序激活条目。这里的冷却是消息计数，不是自然时间。
- [message_builder_service.dart](https://github.com/Chevey339/kelivo/blob/4742d2e2861d963a65d8f642eeba9782566cd426/lib/features/home/services/message_builder_service.dart) 调用激活逻辑，再按位置注入上下文。

借鉴：触发规则必须确定、可解释，反复准备同一请求不能反复推进世界书状态。本项目需把规则评估和状态提交移到服务器，并加入角色知识过滤和 token 预算。

### 记忆

- [memory_pipeline.dart](https://github.com/Chevey339/kelivo/blob/4742d2e2861d963a65d8f642eeba9782566cd426/lib/core/services/memory/memory_pipeline.dart) 明确 Gatekeeper → Extract → Smart Add → Distiller；使用进程内单并发队列，最大 8 项。
- [memory_smart_add.dart](https://github.com/Chevey339/kelivo/blob/4742d2e2861d963a65d8f642eeba9782566cd426/lib/core/services/memory/memory_smart_add.dart) 候选检索后决定 NEW/MERGE/CONFLICT/SKIP，限制可合并目标。当前候选逻辑包含词项命中和同类近期条目补充，不能笼统称为纯向量数据库记忆。
- [memory_entry.dart](https://github.com/Chevey339/kelivo/blob/4742d2e2861d963a65d8f642eeba9782566cd426/lib/core/models/memory_entry.dart) 区分 global/assistant、identity/workflow/voice/instruction、active/archived 与来源类型。
- [memory_block_builder.dart](https://github.com/Chevey339/kelivo/blob/4742d2e2861d963a65d8f642eeba9782566cd426/lib/core/services/memory/memory_block_builder.dart) 以稳定顺序构造记忆块、计算哈希，减少不必要的上下文变化。
- [memory_repository.dart](https://github.com/Chevey339/kelivo/blob/4742d2e2861d963a65d8f642eeba9782566cd426/lib/core/services/memory/memory_repository.dart) 包含完整列表读改写及串行化机制。这是本地实现，不能照搬成多进程服务端事务设计。

借鉴整理流水线、冲突处理、可追踪性；本项目增加剧情记忆、证据关联、角色可见性和持久化任务。不能直接把“工作流/语气”分类当作恋爱剧情的完整记忆模型。

### 主动与 MCP

- [iOS 定时任务说明](https://github.com/Chevey339/kelivo/blob/4742d2e2861d963a65d8f642eeba9782566cd426/docs/ios-scheduled-tasks.md) 明确前台准备、预先登记本地通知、到期后有运行机会才写入会话；没有远端执行器，不能保证任意后台时刻调用模型。README 平台表与该源码文档范围有差异，按具体源码文档说明，不推断商店版本已具备此功能。
- [mcp_provider.dart](https://github.com/Chevey339/kelivo/blob/4742d2e2861d963a65d8f642eeba9782566cd426/lib/core/providers/mcp_provider.dart) 有 SSE/HTTP/STDIO/inmemory、OAuth 会话及 needsApproval。
- [mcp_tool_service.dart](https://github.com/Chevey339/kelivo/blob/4742d2e2861d963a65d8f642eeba9782566cd426/lib/core/services/mcp/mcp_tool_service.dart) 按会话/助手选择服务并映射工具名称。

## 4. SillyTavern 实现细节

- [package.json](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/package.json)：Node、Express、vectra 等依赖。
- [chats.js](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/src/endpoints/chats.js)：按用户目录保存 JSONL，包含完整性检查及备份逻辑。
- [character-card-parser.js](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/src/character-card-parser.js)：PNG 文本块读取 `chara`/`ccv3`，优先 v3。读取这两种元数据不等于完整支持全部 v3 行为。
- [personas.js](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/public/scripts/personas.js)：用户 Persona、描述、注入位置及关联世界书。
- [world-info.js](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/public/scripts/world-info.js)：`getWorldInfoPrompt` → `checkWorldInfo`，结合扫描、递归、激活和预算生成提示词。
- [memory/index.js](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/public/scripts/extensions/memory/index.js)：在前端聊天事件后运行摘要，使用 `setExtensionPrompt` 注入。
- [vectors/index.js](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/public/scripts/extensions/vectors/index.js)：切分、向量化、查询、阈值过滤和注入，与摘要扩展是不同机制。
- [group-chats.js](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/public/scripts/group-chats.js)：NATURAL/LIST/MANUAL/POOLED 发言策略；自然策略考虑发言倾向；自动模式在浏览器 `setInterval` 驱动的 `groupChatAutoModeWorker` 中执行。
- [社区 MCP 扩展](https://github.com/bmen25124/SillyTavern-MCP-Client/blob/04fdfe4410d59534ab379e9741e1277a95f6d384/readme.md) 要求配套服务端插件；[mcp-client.ts](https://github.com/bmen25124/SillyTavern-MCP-Client/blob/04fdfe4410d59534ab379e9741e1277a95f6d384/src/mcp-client.ts) 通过 `/api/plugins/mcp` 发现工具，并注册为 function tools。

借鉴角色卡生态、世界书触发与群聊发言控制；不要照搬浏览器驱动的调度，也不承诺兼容第三方宏、正则脚本、插件和全套前端扩展。

## 5. Aru：只确认产品公开能力

- [官方介绍](https://feedback.aelion.cn/about)：长对话、房间、文档、结构化记忆、跨对话检索、模型、MCP、Calendar/Reminders/HealthKit。
- [隐私政策](https://feedback.aelion.cn/privacy)，生效日期 2026-09-04：大多数记录本地存储，按需把内容送到用户选定的模型/连接服务。
- [App Store](https://apps.apple.com/cn/app/aru/id6781350361) 描述 API Key 存系统钥匙串，无 Aru 账号；1.2 版说明涉及 Aru Host 工作台、待批准操作、主动规则、任务恢复、手机通知、记忆原文、日记整理、语义索引、预设与世界书。

本次没有足够证据确认：Aru 的原生/跨平台 UI 框架、数据库结构、语义召回算法、Host 调度实现、APNs 路径、MCP 传输类型、无设备在线时的执行保证。不得为填满对照表而臆造这些结论。

## 6. 平台与许可结论

- [Apple 后台通知文档](https://developer.apple.com/documentation/usernotifications/pushing-background-updates-to-your-app)：静默推送低优先级，不保证送达，可能被延迟/丢弃，系统唤醒后的执行时间有限。不能用它作为可靠云端调度器。
- [Apple APNs token 认证](https://developer.apple.com/documentation/usernotifications/establishing-a-token-based-connection-to-apns)：签名私钥必须保密，关联开发团队和 App topic。由此推导官方 App + 大量自部署服务应使用受控中继，而非分发官方私钥。
- [MCP 传输规范（2025-06-18 版本）](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports)：STDIO 由客户端启动子进程；Streamable HTTP 允许独立远程服务，取代旧 HTTP+SSE。这里引用的是具体版本依据，不宣称它是 2026 年最新规范；开发时按所选 SDK 核实支持矩阵。
- Kelivo 与 SillyTavern 仓库声明 AGPL-3.0。首版推荐独立实现并复用标准/兼容格式；如复制或改编代码，必须按具体许可检查义务，不能认为自部署或只改成另一种语言即可免除。

## 7. 最值得复用的设计

1. 从 Kelivo 学习结构化配置、记忆整理流水线、稳定上下文和工具授权。
2. 从酒馆学习角色卡、世界书、用户 Persona 与群聊发言控制。
3. 从 Aru 学习持续上下文、任务恢复、回顾和来源可追踪的产品表达。
4. 本项目自行补足：云端持久运行、世界一致性、角色知识隔离、无人剧情预算、自部署升级恢复、双端同步与可选推送中继。
