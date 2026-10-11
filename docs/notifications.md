# P5 通知与中继

Echo 的聊天和后台任务不依赖通知。业务服务器 `PUSH_RELAY_URL` 默认为空；开启后也只在完整消息提交后创建持久投递。推送失败、设备离线或拒绝通知时，消息仍可在 App 重连后同步。通知文案固定为“你的世界有新动态，打开 Echo 查看。”，不显示角色名或剧情。

## 配置自己的中继

中继是独立可选的部署包，与业务 API/Worker 复用 TypeScript 和 PostgreSQL 工具链。生产建议使用独立数据库和域名；不需要 Redis。P5 没有部署官方公共中继，也不分发任何官方 APNs 私钥。自签名 iOS/macOS App 可以各自部署中继。

在仓库外建立权限为 600 的私有环境文件，包含以下字段。每个中继固定一个 sandbox/production 环境，允许最多十个明确列出的 topic。iOS 与 macOS Bundle ID 可一起加入白名单，同一业务实例和中继即可向双端通知。每张邀请和票据仍只绑定一个 topic；测试与生产使用分开的中继环境。

```dotenv
PUBLIC_URL=https://push.example.com
RELAY_DATABASE_PASSWORD=replace-with-random-url-safe-password
RELAY_MASTER_KEY=replace-with-64-hex-characters
APNS_TEAM_ID=YOURTEAMID
APNS_KEY_ID=YOURKEYID0
APNS_TOPICS=your.actual.ios.bundle.id,your.actual.macos.bundle.id
APNS_ENVIRONMENT=sandbox
APNS_KEY_FILE=/absolute/private/AuthKey.p8
ECHO_IMAGE=echo2-server:0.5.0
```

```sh
docker compose --env-file /private/relay.env -f deploy/compose.relay.yaml build
docker compose --env-file /private/relay.env -f deploy/compose.relay.yaml up -d
# 在设备绑定前生成十分钟有效、仅可消费一次的邀请。
docker compose --env-file /private/relay.env -f deploy/compose.relay.yaml exec relay node dist/packages/push-relay/src/main.js invite your.actual.ios.bundle.id
```

业务实例 `.env` 设置 `PUSH_RELAY_URL=https://push.example.com`，重建 API/Worker。中继不能带 URL 凭据、路径、查询或重定向；生产使用公共 HTTPS，连接时重新检查 DNS 并固定 IP。loopback HTTP 只用于显式开启本机开发的合成测试。

在签名工程中设置实际 Bundle ID、Development Team、Push Notifications capability 和 provisioning profile。`APNS_ENVIRONMENT` 构建设置默认 sandbox；TestFlight/App Store 或生产分发必须显式改为 production，确保 entitlement、Info.plist 和中继配置一致。本仓库默认 `CODE_SIGNING_ALLOWED=NO`，真机签名由实际团队配置开启。iOS 使用 `aps-environment`，macOS 使用 `com.apple.developer.aps-environment`。

App → 设置 → 通知 → 允许系统通知，取得设备 token 后输入中继邀请并绑定。绑定有效三十天；到期前可用新邀请重新绑定。后续 App 启动会注册新 token，并使用 Keychain 内的票据直接更新中继地址。拒绝系统权限后可在系统设置修改。关闭 App 内通知、撤销设备或重新绑定会停止旧业务投递，并持久重试中继撤销；过期票据不能继续投递。

## 协议与边界

1. 已配对设备向自己的业务服务器请求十分钟绑定 challenge，绑定 instance ID、data epoch、device ID。
2. App 直接将 challenge、APNs token、topic/environment 和一次性邀请交给中继；中继加密 token，只保存邀请和随机票据的哈希。
3. App 将返回的随机票据交给业务服务器；服务器直接向配置的中继核对全部绑定字段，消费自己的 challenge，然后加密保存票据。跨设备、跨 epoch、过期或重放 challenge 都不能绑定。
4. 业务消息与 notification event/delivery 同事务落库。通知投递使用独立异步循环，网络请求不在数据库事务内，也不阻塞聊天调度。安静时段抑制推送；默认和世界策略一致。
5. 服务器到中继的正文只有 `event_id, delivery_id`，Authorization 是狭窄投递票据。中继生成固定 APNs alert，附随机 event ID、instance ID、epoch；不接收聊天、世界名、角色名、记忆、摘要、模型 Key 或完整工具返回。
6. 点击通知先比对当前服务器身份和 epoch，再以当前设备认证从业务服务器解析事件并同步原文。已删除/失效消息、其他设备、其他实例不能借通知标识读正文。

中继 API：`POST /v1/tickets` 注册；`/v1/tickets/verify` 验证；`/v1/tickets/token` 更新 token；`/v1/tickets/revoke` 撤销；`/v1/deliveries` 投递。除注册使用一次性邀请外，均需票据 Bearer。所有 JSON 拒绝额外字段。固定 topic 白名单/environment、每票据每小时 60 次、每实例每小时 600 次、注册每来源地址每分钟 10 次、token 更新每票据每小时 10 次。无开放注册或管理 Web 页面。

业务网络失败最多五次尝试，间隔一分钟，同 delivery ID 重试。消息超过一天停止补投。中继先提交投递记录，再请求 APNs；重复 delivery ID 不重复调用 APNs，崩溃/响应丢失留为 `unknown`，不自动重发未知结果。APNs `410`、`BadDeviceToken`、`DeviceTokenNotForTopic` 使票据失效；429/服务错误记录失败，用户仍可同步正文。此保守策略允许漏通知，不允许推送失败影响业务事实。系统本身也可能合并、延迟或抑制通知。

`accepted` 只代表 APNs 接受响应，不代表设备显示；状态不提供伪造的“已送达”。可在 App 查看最近二十条本设备状态。票据凭据、APNs token、私钥均不进入普通日志。

## 隐私、存储与真机验收

中继仍可见设备 token、topic、环境、随机实例/设备/epoch 标识、事件/投递标识、请求来源 IP 和时间。中继数据库加密保存设备 token，主密钥独立于业务实例；未开启请求日志，不记录正文。票据过期后定时删除票据及投递记录；邀请过期清理，限速桶超过两小时清理。数据库备份仍可能保留这些元数据，运营者自行配置保留期限。

仅在实际签名和真机上确认：允许/拒绝、前台/后台/锁屏/强退、离线恢复、专注模式、token 更新、sandbox/production 配错、点击认证同步、中继不可用。分别记录云端保存时间、APNs 接受时间、设备显示时间及点击结果。P5 模拟 HTTP/2 协议与模拟器冷启动路由不能替代这组真机结果。用户已表示拥有 Apple 团队，将稍后提供环境信息；尚无真机通过声明。

官方平台依据：[APNs token 认证](https://developer.apple.com/documentation/usernotifications/establishing-a-token-based-connection-to-apns)、[注册远程通知](https://developer.apple.com/documentation/usernotifications/registering-your-app-with-apns)、[APNs 请求](https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns)。
