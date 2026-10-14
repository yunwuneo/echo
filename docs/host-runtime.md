# Echo Host v1（T16–T18）

Host 是现有 Node 24 进程，复用仓库依赖；不安装额外容器、模型或虚拟环境。协议只用于 Echo，不兼容或冒充 Aru Host。生产通信必须 HTTPS；`ALLOW_INSECURE_LOCAL=true` 仅允许回环测试。

## 配对与启动

1. 在 App「数据与诊断 → 定时任务与 Host」生成十分钟配对码。
2. 在 Host 自己管理的私有目录建立权限为 `0600` 的 JSON 配置。字段为 `cloud_url`、`pairing_id`、`code`、`name`、`journal`（专用持久目录）、`roots`（目录代号到绝对路径）、`identities`（远端独立身份名到 `{room_id}`）。该配置由用户提供，不使用手机数据库路径。
3. `npm run host -- pair /绝对路径/host.json`。成功后配置改为节点私钥与令牌，不打印秘密。配对响应丢失需在 App 核对/撤销多余节点再重新配对，不假设原节点未建立。
4. `npm run host -- run /绝对路径/host.json` 持续运行，或 `once` 执行一次收取/对账。SIGINT/SIGTERM 停止轮询。Host 不自动安装系统服务。
5. App 授权必要 action 与 root，再绑定 actor → Host 独立身份。文件范围由 App 授权与 Host 本机 roots 的交集决定。Host 在线只表示最近一分钟签名心跳，不能据此声称模型可用。

对话能力还需 `local_echo:{url,access_token,refresh_token}`。这些凭据属于 Host 自己的 Echo，身份通过 `identities` 指向其普通私聊；访问令牌刷新持久写回私有配置。该本地实例使用自身现有运行引擎、系统提示、历史、模型与 MCP 授权。只配对文件能力不宣称对话可用。

## 作业与对账

请求签名包含版本、节点、时间戳、动作和完整载荷；服务端持有 operation ID、scope、payload hash、预算、execution ID 和回执。accept 不代表执行完成；begin 仅一次确认可开始。开始响应丢失、进程中断或不可判定的外部结果进入 unknown。不要删除 journal、换 operation ID 或手工把 unknown 改回 pending 来“重试”。

完成后回执丢失会从 journal 原样回传。Host 对话按原 job ID 查询自己 Echo 的原 run，不能另发一轮。用户可在 App 查看 Host 作业真实回执；未知外部效果需从相应外部资源核对。主动接管须先对账旧作业并取得签名撤销确认，不能因手机超时抢占。若用户明确撤销节点，权威会原子失效令牌、epoch 与租约，并暂停计划；旧 unknown 仍阻止接管，须由用户核对外部结果后明确登记证据。

`shared-facts.json` 只含主动选择的事实/长期资料版本快照；失效后同步空正文。它不自动导入远端记忆库。插件网络只允许显式 origin，通过既有安全网络层；Python 仍禁止文件/进程/直接网络旁路，根目录授权不是任意 Python 文件读写许可。

## 目录与恢复点

普通文件限制 1 MiB，拒绝 `..` 和符号链接；写前比较完整基线哈希。冲突结果保留外部内容与草稿。`.echo-lock` 为本次写入协作锁；中断遗留时不得仅按年龄删除。需要管理员确认没有旧写入进程且保留原件后处理。

备份使用 `echo-restore-points/` 内内容寻址的加密 JSON、256 KiB 临时分块与 manifest。自有业务包明文上限 16 MiB、远端加密包上限 24 MiB。上传未完整验证前不发布恢复点、不删旧点；默认保留全部（keep_count=0）；用户明确选择正数后，验证后按计划保留数和 manifest revision 删除，至少留一个验证过的恢复点。分块在最终发布后清理。不要把用户其他目录当缓存清理。

本机测试使用合成数据与临时目录；真实 TLS、电脑/VPS 网络中断、真实模型/MCP 和真实磁盘故障尚须独立验收。版本/日志/状态只显示可核实证据，不包含 Key 或隐藏推理。

## 明确登记未知结果

已核实外部效果后，仍有效的 Host 可执行 `npm run host -- resolve /绝对路径/host.json /绝对路径/evidence.json`。证据文件包含 `job_id`、`state`（`completed` 或 `failed`）、`result`（实际结果）及可选 `error_code`；命令核对原 execution ID，只保存并补交结果，不再执行动作。完成状态必须来自实际核对，不能用来绕过 unknown。

节点已撤销时，App「Host 高级配置」的 `reconcileHostJob` 使用当前 revision、`id`、`state`、`result`、非空 `evidence` 和 `confirmed:true` 登记用户证据。它保留操作回执、禁止重复执行；旧作业完成对账后才可 `confirmHandoff`。系统动作未知同样可在系统页面登记外部 ID 与核对说明，换设备不会自动重做旧动作。

委托定时任务还需要 Echo 全局与对应世界的主动联系开关；提交与执行前会再次核对。备份计划可直接暂停，无需重新输入密码；排队作业失效，已接受/执行中的作业保留未知状态等待对账。迁入另一实例时原始 execution/receipt/远端对象 ID 保持不变，不能把本地重映射 ID 当成远端资源 ID。
