# Echo

2026-10-11：进入已授权的 P6（T13），当前版本 **0.6.0 本地候选**。新增容量优化、中文剧情评估/人工评分、验收与兼容追踪、隐私清单及候选包工具。证据与尚未通过的真实模型、真机和发行门槛见 [P6 报告](docs/p6-report.md)，操作见 [P6 验证指南](docs/p6-usage.md)。T13 综合验收仍进行中。

## 开发与验证

固定 Node 24.14.0、npm 11.9.0，数据库 PostgreSQL 17 + pgvector 0.8.2。依赖锁文件已保存。不要用生产数据库运行测试，也不要把真实聊天或 Key 写入测试数据。

```sh
npm ci --ignore-scripts
npm run lint
npm run typecheck
npm test
npm run test:evals
npm run contracts:check
npm run build
```

集成测试启动专用临时数据库，包含 Worker 子进程 SIGKILL 与重启恢复：

```sh
docker compose -f deploy/compose.test.yaml up --build --abort-on-container-exit --exit-code-from tests
docker compose -f deploy/compose.test.yaml down
```

使用已有专用数据库时，显式指定 `TEST_DATABASE_URL`，数据库名必须是 `echo2_test`。测试会清空该库的业务数据，不读取 `.env`。

```sh
TEST_DATABASE_URL=postgresql://echo2:synthetic-test-password@127.0.0.1:5432/echo2_test npm run test:integration
```

`contracts:generate` 从 TypeBox/Fastify schema 同时生成后端 OpenAPI 与 Apple 包输入；`contracts:check` 验证两份均无漂移。Swift 客户端由官方构建插件生成，不手改生成代码。

```sh
swift test --package-path apps/apple/Packages/CompanionCore
xcodebuild -project apps/apple/Companion.xcodeproj -scheme Companion-iOS -destination 'generic/platform=iOS Simulator' -derivedDataPath .local/ios CODE_SIGNING_ALLOWED=NO -skipPackagePluginValidation build
xcodebuild -project apps/apple/Companion.xcodeproj -scheme Companion-macOS -destination 'platform=macOS' -derivedDataPath .local/macos CODE_SIGNING_ALLOWED=NO -skipPackagePluginValidation build
```

最低部署系统 iOS 18 / macOS 15；构建工具需要支持 Swift 6.2+。工程可由 XcodeGen 2.46.0 的 `apps/apple/project.yml` 重建。CI 使用相同检查，但尚未在远程运行。`test:evals` 使用 100 条合成中文查询，报告词项 recall@5 和负例误召回；不代表真实模型质量验收。

初次部署与 P1 API 使用见 [自部署说明](docs/self-hosting.md)，验证边界见 [P0–P1 实施记录](docs/p0-p1-report.md)。服务器与客户端发行许可证均待定，当前没有创建 LICENSE 或发布源码。
