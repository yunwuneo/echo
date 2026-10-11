# P3 记忆、世界书与导入使用

P3 增加迁移 `003_memory_and_imports.sql`。按 [自部署说明](self-hosting.md) 升级 API 与 Worker；先备份数据库和主密钥。既有世界默认关闭自动记忆，不会在升级后自行调用模型。P3 仍不包含 P4 的 MCP 或无人剧情。

## 记忆

在「管理世界 → 记忆与来源 → 记忆与嵌入设置」开启自动整理。使用每个房间的聊天模型；8 条新完成消息或最后一次完成已空闲 60 秒时合并，单批最多 40 条。Worker 通过持久队列处理，关闭客户端不影响执行。提取失败最多尝试三次，界面显示错误并支持重试；失败不推进游标。

自动提取采用保守的逐字摘录：内容与主题都必须能在引用的原消息中核对。用户陈述保留为陈述，角色说法保留为未确认声称，不改写世界事实。相同内容与受众去重、合并证据；同主题不同内容进入冲突列表，自动任务不会覆盖人工纠正。此方案未承诺能理解所有语义相近表达。

点开记忆可看原文、可知角色与修订，修正内容、固定为核心记忆或明确替代旧条目。可知角色只能缩小证据交集；空交集表示仅主人可见，**不是世界内公开**。跨房间召回只对原本知道来源的角色开放；跨世界不共享。HTTP 编辑使用 `If-Match`，冲突须退出并打开最新条目比较，草稿不会自动覆盖服务器。

「忘记」清空记忆及相关派生记忆、向量与修订内容，原消息及实际 prompt 依赖后代不再进入角色历史或提取；原文仍可由主人在聊天中查看。「删除原文及依赖内容」还会擦除这条原文及其依赖消息，执行前需取消本世界活动运行。该策略保守，可能影响多条后续消息。仅软删除世界/房间仍不等同隐私擦除。

遗忘/删除使旧提取、旧嵌入和旧快照失效。在线设备通过 410 重建缓存；离线设备在重新连接前仍可能保留旧缓存。已有备份及第三方模型服务保留的数据不由这次数据库操作擦除，备份策略在 T12 完成。原消息主动重写新事实仍属用户新输入，不承诺自然语言层面永久禁词。

## 嵌入与预算

不配置嵌入时使用中文字符二元组及英文词项召回，聊天与记忆继续可用。需要语义召回时，先在设置新增支持 OpenAI-compatible `/embeddings` 的连接，再在世界的记忆设置中选择它并填写精确维度（1–4096）。连接的模型 ID 是嵌入模型 ID，不应把它选作聊天房间模型。

修改嵌入连接或维度增加索引版本并清理旧向量，后台逐条重建；不同版本和维度不混算。超时、服务错误或维度不符时降级词项检索，界面显示错误，自动冷却 5 分钟，也可明确重试。新索引是 pgvector 精确距离扫描；容量性能尚未验收，不声称已有 ANN 加速。

所有提取、索引和语义查询共用后台预算，默认：

| 环境变量                         | 默认值 |
| -------------------------------- | ------ |
| `BACKGROUND_DAILY_REQUEST_LIMIT` | 20     |
| `BACKGROUND_DAILY_INPUT_LIMIT`   | 100000 |
| `BACKGROUND_DAILY_OUTPUT_LIMIT`  | 10000  |

按服务器 UTC 日期计数，预留事务保证并发不超卖。输入使用保守 UTF-8 字节估计、输出按请求上限预留；已知计费用量另记，预留不退款。没有 usage 的请求记 unknown，不能解释为免费。P4 会接入统一自主类别开关与用户时区；P3 的世界自动整理开关和可选嵌入配置为明确授权入口。

## 世界书规则

世界书编辑增加关键词/RE2 正则、持续、冷却和延迟。只扫描当前角色能读取的历史。规则状态按房间、角色、条目修订保存；每次角色成功回复提交一个计数。预览、请求重试、流中断不推进；受限重生成移除旧轮效果后重建计数。

- 延迟 N：连续 N+1 次触发时才生效；中断命中会重置等待。
- 持续 N：从触发回复算起共 max(1,N) 次；持续期结束后开始冷却。
- 冷却 N：持续期结束后的 N 次回复不再激活。
- 高优先级先选；预算沿用输入可用量的 20%，绝对上限 4096 个保守估算单位。超限不注入并记录 Manifest，规则计数仍按成功回复提交。
- 不支持回溯引用和环视；例如 `(a)\1`、`(?=x)` 会被拒绝。RE2 的线性匹配避免灾难性回溯。

## 导入

「管理世界 → 导入角色卡或世界书」选择 JSON/PNG，或粘贴 JSON。预览显示角色、条目数、字段映射、不支持项和冲突；明确选择「跳过同名项」或「创建副本」后确认。世界改变会要求重新预览，同一文件和世界只提交一次，失败不产生半成品。角色卡创建模板与当前世界实例，附带世界书只授权给该新角色；独立世界书使用预览时选定的可知角色，未选表示公开。

| 输入                                             | 执行子集                                                                                                                                                    |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chara_card_v2` / `2.0`；`chara_card_v3` / `3.0` | name、description、personality、scenario、mes_example、first_mes、alternate_greetings、character_book；system_prompt/post_history_instructions 默认关闭建议 |
| PNG                                              | IHDR/CRC/边界检查，tEXt/zTXt/iTXt 中的 chara/ccv3 元数据；同时存在时 ccv3 优先                                                                              |
| 世界书                                           | entries 数组或对象；key/keys、content、constant、disable/enabled、order/insertion_order、scanDepth、caseSensitive、depth、sticky/cooldown/delay             |
| 位置                                             | 0 / before_char → 角色前；1 / after_char → 角色后；4 → 历史深度                                                                                             |
| 正则关键词                                       | `/RE2/`、i/u 标志；普通词与正则混合时普通词被转义                                                                                                           |

JSON 最多 5 MiB、PNG 最多 10 MiB、解压后元数据最多 5 MiB、每文件最多 2000 条。无效范围与恶意/无效正则报告为错误并阻止提交；未知槽位、二级关键词、概率、向量触发条目会停用并说明。不执行宏、脚本、递归或远程 URL。system_prompt 与 post_history_instructions 保留为默认关闭的建议，预览中可分别阅读并明确开启；启用后的建议仍服从运行与权限约束，也可以在模板编辑页关闭。优先级与计数语义以 Echo 报告为准，不声称完全兼容酒馆。

原始文件按字节完整保留，导入后可下载含未知扩展的原件；这不是重新导出编辑后的完整 v2/v3 卡片。PNG 图像像素保留在原件中，当前导入不将其安装为客户端头像。开场白和示例保留为模板资料，不自动制造历史消息。

## 接口与验证

新增 REST 契约由 [OpenAPI](../packages/contracts/openapi.json) 生成。主要入口：世界 `/memory-settings`、`/memory-status`、`/memory-retry`、`/memories`；记忆 `/v1/memories/{id}` 与 `/revisions`；原文 `DELETE /v1/messages/{id}`；导入 `/v1/worlds/{id}/imports/preview`、`/v1/imports/{id}/commit`、`/original`。读取需设备认证，写入记忆/设置需修订号。

新增 `memory`、`memory_settings` 同步实体及 `memory`、`lore-rules`、`card-imports` capabilities。旧客户端更新角色或世界书时，未提供的 P3 字段由服务器保留。P3 UI 使用新版服务；完整发行兼容矩阵仍属 T13。

```sh
npm run lint
npm run typecheck
npm run contracts:check
npm test
npm run test:evals
docker compose -f deploy/compose.test.yaml -p echo2-p3-tests up --build --abort-on-container-exit --exit-code-from tests
docker compose -f deploy/compose.test.yaml -p echo2-p3-tests down
```

Swift 与模拟器测试沿用 [P2 联调命令](p2-usage.md)，新增 XCTest `testMemoryCorrectionForgettingAndImportPreview`。全部测试使用合成数据，未调用付费模型。
