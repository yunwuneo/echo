# P2 使用与本机联调

服务器沿用 [自部署说明](self-hosting.md)，启动前执行新增迁移。只在自己管理的实例使用真实模型配置；测试一律使用合成数据。

## 客户端流程

1. 启动 API/Worker，使用 CLI 创建一次性配对码。
2. 打开 iOS/macOS App，填写 HTTPS URL、设备名与配对码。发行构建不接受 HTTP；Debug 可明确开启仅限 loopback 的 HTTP 调试。
3. 设置 → 添加模型连接，填写地址、模型 ID、Key 和上下文/输出上限。Key 上传到自己的服务器并加密保存。
4. 设置 → 新建角色模板。创建世界并填写背景与玩家虚构身份。
5. 管理世界 → 从模板添加角色 → 新建私聊或群聊 → 选择模型和成员。
6. 发消息时可按规则回应，或从点名菜单选择角色。服务器最多接力三位；切页或关闭 App 不取消云端运行。
7. 管理世界中编辑基础世界书；剧情页可查看来源、确认/纠正事实及配置可知角色。未选可知角色表示世界内公开。
8. 离线消息显示“待发送”，接收 ACK 后显示“服务器已接收”；完成状态以同步结果为准。重新打开会补拉消息；切换服务器不会跨实例发送旧草稿。

模板更新不会自动升级世界角色；在世界角色编辑页选择版本。消息中的“重生成此轮”由服务器检查最后一轮和依赖条件，不符合时返回冲突。

## 协议增量

所有写接口均需设备 Bearer。新增实体为 `worlds`、`characters`、`actors`、`rooms`、`lore`，提供 POST/PUT/DELETE；编辑与移除需要十进制 `If-Match` 修订号。读取通过同步快照与增量，完整字段以 [OpenAPI](../packages/contracts/openapi.json) 为准。

- `PUT /v1/worlds/{id}/state`：带状态修订确认剧情，只接受地点、时间、在场角色和未完成话题。
- `GET /v1/runs/{id}/manifests`：查看来源引用、版本、选择/裁剪理由与估算，不返回隐藏推理或原始 prompt。
- `POST /v1/runs/{id}/regenerate`：提交新的 `client_command_id`，返回稳定 ACK。
- `POST /v1/sync/snapshots`：创建固定水位快照，返回快照 ID 和高水位。
- `GET /v1/sync/snapshots/{id}?after=0&limit=500`：读取下一页；全部落地后从高水位补拉 `/v1/sync`。快照 10 分钟过期后重新开始。
- `GET /v1/events`：使用持久游标恢复 SSE；事件正文是实体完整替换值，不能当成文本片段追加。

事件保留 7 天，过期游标返回 410。`*_deleted` 移除工作区实体；世界/房间移除也清理相关客户端展示。协议版本仍为 v1，新增客户端要求 `group-runs`、`paged-snapshots` capabilities；P1 旧验证室仍能执行文本命令，升级成员配置后即可使用角色。

## 合成 UI 测试

iOS 模拟器运行需要本地签名才能读写 Keychain。`project.yml` 与生成工程已为 `iphonesimulator` 默认启用签名并使用 `-` 本地身份；直接在 Xcode 选择 `Companion-iOS` 和模拟器后 Run 即可。不要在实际运行时覆盖 `CODE_SIGNING_ALLOWED=NO`（该选项仅用于构建检查）。测试后端重建后，旧实例会话可能失效，此时在设置中切换服务器，再获取新的 `/__test/code` 配对。

专用 Compose 项目使用 tmpfs 数据库，只有 fixture 端口绑定 `127.0.0.1:3012`；`/__test/*` 仅存在于测试入口，不能用于部署。用户已授权本次本机 HTTP 合成测试。不要把此 fixture 暴露到网络。

```sh
docker compose -f deploy/compose.ui-test.yaml up --build -d
xcrun simctl list devices available
xcodebuild -project apps/apple/Companion.xcodeproj -scheme Companion-iOS -destination 'platform=iOS Simulator,id=34F8DBDA-87C9-4518-960E-56D6A03321CB' -derivedDataPath .local/ios -resultBundlePath .local/p2-ios-ui.xcresult CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=- -skipPackagePluginValidation test
docker compose -f deploy/compose.ui-test.yaml down
```

替换为自己机器的模拟器 UUID；每次使用新的 resultBundlePath。UI 测试会自动获取合成配对码，并在 Debug 中填入测试 URL。Keychain 验证需要签名，`CODE_SIGNING_ALLOWED=NO` 只用于构建检查，不能代替实际运行验收。Mac 可用同一 fixture、`Companion-macOS` scheme 和 `platform=macOS`；本机 XCTest runner 未能启用自动化，实际手动验证及限制见 [实施记录](p2-report.md)。双端 UI 测试应顺序执行，避免互相改变共享 fixture 的离线状态。

后端集成测试仍运行 `deploy/compose.test.yaml`，与 UI 测试是不同 Compose 项目/临时数据库。共享 Swift 测试使用：

```sh
swift test --package-path apps/apple/Packages/CompanionCore --scratch-path .local/swift-build
swift test -c release --package-path apps/apple/Packages/CompanionCore --scratch-path .local/swift-build
```

Debug 与 Release 分别检查 URL 策略；Release 即使从 Keychain 恢复旧 Debug 连接也拒绝 HTTP。UI fixture 为三步持久队列提供 30 秒整轮窗口，真实超时行为由后端故障测试单独验证。
