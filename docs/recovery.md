# 备份、恢复、密钥轮换与升级

P5 使用 `scripts/ops.mjs` 驱动 Docker Compose；需要 Node 24 和 Docker Compose v2。命令必须从仓库根目录执行，环境文件使用绝对路径并限制为本人可读。默认项目名 `echo2`，其他名称必须与实际部署一致。工具不读取聊天到普通日志，不发送外部模型或工具请求，不在公网提供恢复接口。

## 备份

```sh
node scripts/ops.mjs backup /private/echo.env echo2 /private/backups/echo-20261011
node scripts/ops.mjs verify /private/echo.env echo2 /private/backups/echo-20261011
```

输出目录必须尚不存在。工具依次停止 proxy/API/Worker、开启数据库维护模式、确认没有活进程持有运行锁，然后执行 PostgreSQL 17 custom-format `pg_dump`。备份包括所有业务表、加密凭据、导入原件/头像；当前资源都在 PostgreSQL，没有额外业务资源卷。排除可重建的 `pgboss` 任务表和独立中继 schema；领域 run/outbox 仍保留。TLS 证书由 Caddy 重新取得，不作为业务数据恢复。

备份目录权限 700、文件 600，包含 `database.dump`、`privacy-ledger.json` 和 `manifest.json`。Manifest 声明格式版本、PostgreSQL 主版本、迁移及内容清单、各文件 SHA-256/大小。校验和用于发现损坏，不验证来源真实性；只恢复可信备份。数据库中聊天与原件仍为明文，备份应放在加密磁盘或加密归档中。主密钥和版本必须单独安全保管，不写入备份目录、Git 或镜像。丢失主密钥无法解密模型/MCP/推送凭据。

备份成功或失败都不会自动恢复后台执行；失败的 `.partial` 文件不能被当成备份。普通备份后，如果继续使用原实例：

```sh
docker compose --env-file /private/echo.env -f deploy/compose.yaml run --rm --no-deps api node dist/packages/server/src/cli.js maintenance off
docker compose --env-file /private/echo.env -f deploy/compose.yaml up -d api worker proxy
```

不要在计划切换到恢复实例时重新启动原实例。数据库磁盘写失败不会发送尚未保存消息的通知。备份目标磁盘写入失败/pg_dump 失败时缺少完整 manifest，工具返回失败且保持停服；P5 尚未做真实磁盘耗尽注入实验。

## 删除记录和旧备份

删除正文、遗忘记忆会保存仅含 owner/实体 ID/类型的删除记录；事务提交后可以独立导出，不含删除正文：

```sh
node scripts/ops.mjs privacy-export /private/echo.env echo2 /private/backups/latest-privacy-ledger.json
```

该文件也必须是新路径。定期将最新删除记录随备份安全保存，恢复旧备份时传入最新版本。工具会校验实例身份，再沿已有来源失效逻辑清理旧内容及派生数据。P5 迁移会从既有的 deleted/invalidated 状态补入可识别的删除 ID；无法从没有记录的旧状态推测所有历史删除。

备份本身不会因在线删除被改写。建议保留每日七份、每周四份作为明确的初始运维策略，由部署者按需要调整并实际清理；P5 不会自动删除备份目录。若最新删除记录已经丢失，恢复更早备份可能恢复已删除内容；保持维护模式并人工核对，不能声称删除记录不存在时仍可完整还原遗忘意图。

## 恢复到隔离实例

准备单独目录/主机、独立项目名、空数据库卷和目标环境文件，填入备份对应的主密钥/版本。原实例维持停止，目标先不切 DNS，也不启动 API/Worker/proxy。工具拒绝覆盖任何非空目标库。

```sh
node scripts/ops.mjs restore /private/restored.env echo-restored /private/backups/echo-20261011 /private/backups/latest-privacy-ledger.json
```

最后一个参数可省略，省略时只应用备份自带删除记录。恢复先验证 SHA-256/大小和格式，再用 `pg_restore --single-transaction --exit-on-error` 导入空库；检查迁移、主密钥、消息等八类内容的数量与摘要。校验失败时不启动目标服务；保留隔离库供诊断，重试应创建另一个空目标，不能覆盖失败库。

恢复准备会：

- 保留实例身份，生成新的 `data_epoch`，撤销全部设备会话和配对码，清除旧快照。
- 关闭自主总/世界开关、读写工具权限、MCP 连接和授权、推送绑定；不自动恢复外部权力。
- 中断所有未完成 run，清空租约并提高 fencing token；待审批动作过期，已 dispatch 工具保留 `outcome_unknown`，不自动重放。
- 将未完成计费用量标记 unknown；保留业务数据、来源、原件和副作用审计。
- 应用删除记录并保持维护模式。恢复数据不会直接触发云端续跑。

P5 所有 API/Worker 在进程生存期持有数据库共享运行锁，离线密钥/恢复操作要求独占锁，防止仍在运行的进程使用旧密钥或状态。维护开关阻止新业务请求/领取任务；已有外部请求不能被视为已撤销，所以正式备份与轮换必须先停进程。

确认原实例已停止、内容检查和新删除记录已核对后，才显式切换：

```sh
docker compose --env-file /private/restored.env -f deploy/compose.yaml -p echo-restored run --rm --no-deps api node dist/packages/server/src/cli.js maintenance off
docker compose --env-file /private/restored.env -f deploy/compose.yaml -p echo-restored up -d api worker proxy
docker compose --env-file /private/restored.env -f deploy/compose.yaml -p echo-restored exec api node dist/packages/server/src/cli.js pair
```

多台机器之间没有凭空可用的分布式停源证明；脚本会停止本项目源进程，并让恢复实例默认完全无自主权限。操作者必须避免手动重新启用旧实例。重新配对后客户端建立新 epoch 缓存，旧草稿仍留在旧命名空间。确认状态后再逐个恢复模型/MCP 连接授权、自主策略和设备推送；旧 APNs 票据在原中继撤销或等待过期。

## 主密钥轮换

先完成备份并保持停服/维护。生成独立的新 64 位十六进制密钥文件，权限 600，以只读 secret 文件方式挂载；不要把新密钥直接写进命令行。

```sh
openssl rand -hex 32 > /private/echo-next-key
chmod 600 /private/echo-next-key
docker compose --env-file /private/echo.env -f deploy/compose.yaml run --rm --no-deps \
  -v /private/echo-next-key:/run/secrets/next-key:ro \
  -e NEW_MASTER_KEY_FILE=/run/secrets/next-key api \
  node dist/packages/server/src/cli.js rotate-key
```

轮换在单个数据库事务内，先认证旧主密钥，解密再加密模型、MCP、推送绑定和待撤销票据，最后换实例 key check。任何凭据认证失败全部回滚；需要新密钥且版本恰好加一。成功后，将私有环境文件里的 `MASTER_KEY` 更新为该新值、`MASTER_KEY_VERSION` 加一，再用 `diagnostics`/启动检查验证。数据库事务和外部 env 文件不可能原子提交，因此全过程保持维护；未更新配置前启动明确失败。

新旧备份分别需要它们当时的主密钥版本。保留仍有效备份对应的旧密钥，不能在轮换成功后立即丢弃。中继有独立主密钥，业务轮换不修改中继；中继换密钥应先停服，保留旧备份密钥，并让设备重新绑定，当前未提供中继票据库原地再加密 CLI。

## 升级与回退

将 `ECHO_IMAGE` 固定到已验证版本或 digest，保存当前镜像和升级前备份。API/Worker 必须同版本。迁移按文件校验和与 advisory lock 串行执行，每个文件一个事务；改写已应用迁移会拒绝运行。P4→P5 只增加表/字段，已有通知默认关闭，业务权限不扩大。

先停自主/MCP 写入并备份；构建新镜像，在隔离副本执行迁移和冒烟，再切换正式实例。P5 初版备份格式为 v1，没有已经发行的上一格式可迁移；未知版本明确拒绝。数据导出和数据库备份格式不同，不能拿 JSON owner archive 当作 pg_restore 文件。

若 schema 仍兼容旧镜像，可在停服后将 `ECHO_IMAGE` 改回已验证版本；旧 P4 程序不了解 P5 的维护标记，绝不能拿它直接启动尚未核验的恢复库。跨不兼容 schema 回退时，按上述流程恢复升级前备份到另一个隔离空库，核对内容及删除记录后再切换，不编写反向 SQL。说明备份时间到切换间可能丢失的新增数据，现实工具副作用须在目标系统人工核对，数据库回滚不能撤销它们。

## 可复现合成演练

```sh
docker build -t echo2-server:p5-local .
node scripts/recovery-drill.mjs --synthetic
# 本机有上一阶段镜像时，可额外验证实际 API/Worker/快照兼容回退
node scripts/recovery-drill.mjs --synthetic --previous-image=echo2-server:p4-local
```

该脚本只创建随机命名的专用 Compose 项目/卷，写合成中文消息与凭据，验证健康启动、数据库重启、备份、损坏文件拒绝、错误主密钥拒绝、非空目标拒绝、隔离恢复数据摘要、较新删除记录、凭据解密、显式切换与重新配对；最后清理自己创建的容器/卷。报告和备份保留在 `.local/p5-recovery-<id>/`，不访问真实数据，不调用真实模型/MCP/APNs。Docker Desktop 的 Linux 容器验证不等同于未配置的独立 Linux 主机或真实磁盘故障验收。

## 2026-10-14 自有 App 规格增量注意事项

007–012 迁移新增命令回执、资源引用、模型线路与快照、消息版本、聚合队列、分支来源。`inventory` 纳入新业务表，旧 `pg_dump` 全库路径自然包含新增表；**本轮只验证了带内容的 006→当前 schema、重复迁移和故障迁移回滚，没有运行新版完整 dump/restore 演练**。不得将旧 P5 演练结果代替新 T06 自有加密包、对象预览、冲突保护、OriginMap 和续导验收。

升级前仍须停执行器、备份并验证隔离恢复。禁止把“加法迁移”理解为可以安全用旧程序直接写新版库：旧版本不理解三态禁用、消息选中版本和分支来源，可能绕过新行为。回退应停止程序，将升级前备份恢复到隔离空库，应用最新隐私删除记录并核对时间差内新增数据；不执行不可逆 down SQL，不原地覆盖现有库。

新版隐私擦除还会清除消息版本、消费队列副本和分支派生原文，解除相应资产引用但保护共享原件。结果未知的外部动作保留核对所需参数/摘要，直到人工核对后清除参数；数据库恢复绝不能重新提交它们。恢复后关闭外部权限、暂停主动动作、切换 data_epoch 的原流程继续适用，手动队列恢复为数据，不会自行召唤。

## 自有加密业务包 v1（T06）

原生“我”中的备份恢复入口提供加密导出、文件读取、密码验证、逐记录预览和显式应用；世界详情中的项目文档支持 revision/hash 冲突保护、历史版本恢复和附件引用。可读 JSON/Markdown/PDF 导出不是恢复包。

业务包使用 scrypt + AES-256-GCM，包含所列业务表、所有消息版本、选中关系、文档/历史附件、导入原件及资产原件。迁移名称/校验和必须与目标匹配，旧格式升级须显式开发迁移器；错误密码、schema 不匹配、损坏原件均在业务写入前拒绝。包不含模型/MCP 凭据、设备认证、推送/执行队列、向量索引、请求快照或临时回顾。主密钥不需要随业务包迁移；恢复后连接待重新填写凭据。维护 pg_dump 仍需原主密钥，保留上述全部数据库状态，遵守本指南原有隔离恢复流程。

当前业务格式限制 16 MiB 明文、每表 10,000 条、单原件 1 MiB；完整 owner 关系图作为一个原子对象。先预览再应用，预览后的本地变化使 token 失效；旧包与本地修改冲突，只能明确保留本地或取消。映射和业务同事务提交，故障从同一预览重试整个对象，不存在部分导入成功。已有隐私删除阻止旧包复活原文。恢复不启动任务，未完成运行标 interrupted，连接/授权/计划暂停。

暂存包在服务器再次认证加密，最多保留当前和两个其他包，24 小时后在下一次预览清理；用户导出的原文件不会被自动删除。服务器隐私擦除会删除暂存包。没有远端恢复点自动保留策略（T18）。

健康检查校验资产、当前文档和历史文档哈希。维护命令按预计数据库体积检查主机与数据库卷空间，至少保留 64 MiB 且通常要求估计体积两倍；无法确认或不足在停服务/恢复写入前拒绝，不主动删除原件腾空间。空间不足只经过注入测试，不宣称真实磁盘耗尽/断电已验证。

本轮在独立 tmpfs 数据库做加密往返、版本关系、重复导入、冲突、错误密码、损坏资源、注入事务异常及真实终止恢复数据库连接后的无半写入/续导。没有对生产数据库或现有 echo-postgres-1 执行恢复，没有重新运行运维整实例 dump/restore；后者仍需目标环境演练。精确测试数量见 [实施进度](app-spec-progress.md)。

### 021–030 增量数据保护

业务包新增记忆资料/纠正/整理记录、书库绑定、扩展/安装回执、媒体作业与资源引用、语音记录、作品源码/状态/冲突副本及群策略。排除原话/事实向量和作品临时会话；恢复后扩展 Skill 关闭、群工具关闭、作品禁运行、语音关闭，进行中的媒体状态为 unknown，不重放生成。当前业务包仍限 16 MiB，超限明确失败，整实例大备份沿用维护流程。

020 里程碑的已认证业务包可以通过明确的字段默认值/空新表转换器升级；旧 schema checksum 必须匹配本仓库，未知旧版/新版不猜测转换。转换只在内存中处理，原包不改写。恢复前拒绝活动对话、作品会话及提交中的媒体，以防旧执行结果覆盖恢复数据。默认保留有冲突本地内容需用户在预览选择；被隐私擦除的消息、资料、纠正与语音不得从旧包恢复。
