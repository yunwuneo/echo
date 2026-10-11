# P6 验证与本地候选包

P6 是 T13 综合验收阶段。`0.6.0` 表示本地候选版本，不表示真机、真实模型、独立主机和完整发布门槛均已通过。实际结果见 [P6 报告](p6-report.md)，接口兼容见 [能力矩阵](compatibility.md)，数据流见 [隐私数据清单](privacy-data.md)。

本轮 Docker 失联后用户选择不重启。以下 Docker 命令保留为环境恢复后的复现步骤，当前 UI 复测、候选运行镜像和完整耐久测试均未完成；源码包可独立生成。重跑前先核对遗留专用项目/卷并保存旧报告，不覆盖已有证据。

## 容量与耐久

工具只接受数据库名 `echo2_benchmark`，已有 owner 时拒绝运行。Compose 使用专用项目和持久卷，无宿主端口；应用/Worker/模拟模型/两个 HTTP 观察客户端共 1 CPU/2 GiB，数据库 1 CPU/2 GiB。总配额 2 CPU/4 GiB 不等于一台物理独占的 2 核服务器。记录宿主 Docker 环境、磁盘类型和其他负载。

```sh
docker compose -f deploy/compose.benchmark.yaml -p echo2-p6-capacity up --build --abort-on-container-exit --exit-code-from benchmark
docker compose -f deploy/compose.benchmark.yaml -p echo2-p6-capacity down -v
```

仅这里的专用合成数据可用 `down -v` 清理，不对实际部署执行。报告保存到 `.local/p6-benchmark/capacity.json`，每十秒更新。种子为 10 世界、80 世界内角色、100000 消息、10000 有来源记忆、2000 世界书。默认持续十分钟、每分钟六次输入，启动时另发十个并发命令，混合真实 pg-boss 后台记忆任务。断言必须发生后台请求，全部前台运行完成，且限额未超支。

报告包括 ACK、提交至 HTTP 客户端观察的保守上界、检索+组装、完成延迟、分页快照、SQL 数量、索引计划、进程 RSS/CPU、数据库大小、同步事件和队列积压。`sync_events.created_at` 是事务开始时间，故观察延迟包含提交前开销；模型模拟固定约 350ms，模型延迟与自身开销分列。HTTP 观察客户端不等于 Apple 屏幕渲染，也不包含公网/TLS。

无人耐久使用另一个全新项目，不发送前台输入、不轮询认证客户端，半程重启 Worker 调度器；不替代已有 SIGKILL 进程测试。运行期间保留宿主唤醒和 Docker。必须读到最终 `status=completed`、`checks.full_24h=true` 和全部检查通过，才能记录 24 小时已验收。

```sh
BENCH_MODE=soak BENCH_SECONDS=86400 docker compose -f deploy/compose.benchmark.yaml -p echo2-p6-soak up -d --build
docker compose -f deploy/compose.benchmark.yaml -p echo2-p6-soak logs --tail=20 benchmark
# 读 .local/p6-benchmark/soak.json；结束后清理本专用项目。
docker compose -f deploy/compose.benchmark.yaml -p echo2-p6-soak down -v
```

`BENCH_SECONDS` 可用于短时冒烟，但少于 86400 秒的 soak 不通过完整耐久门槛。各模式报告同名覆盖，重跑前保存旧证据。中断留下 `running` 也不能算通过；不可在同一卷继续从头播种。当前快照创建仍物化整份数据，初次同步和 SwiftData 大缓存全量载入的峰值还需在物理设备测量。

## 中文模型评估

`npm run test:evals` 默认完全离线：100 条记忆查询（80 正例、20 负例），加上 20 段三轮剧情编译。离线占位答复不评分，不自动声称真实语义质量。

真实评估只接受显式 `--live`，不读 `.env`，用独立测试 Key 的环境变量。下面是配置结构；端点/模型名须替换为真实选择，Key 不写入 JSON。预算是单次评估进程的保守请求/输入/输出预留，未知结果不退款、不自动重试，不是货币费用保证。完整两配置、20 剧本、每剧本 3 次、每次 3 轮需要 360 请求，输出上限 184320 token；预算不足会停在当前进度。

```json
{
  "providers": [
    {
      "name": "model-a",
      "base_url": "https://model-a.example/v1",
      "model": "chosen-model-a",
      "api_key_env": "ECHO_EVAL_KEY_A"
    },
    {
      "name": "model-b",
      "base_url": "https://model-b.example/v1",
      "model": "chosen-model-b",
      "api_key_env": "ECHO_EVAL_KEY_B"
    }
  ],
  "budget": {
    "requests": 360,
    "input_tokens": 1500000,
    "output_tokens": 184320
  }
}
```

```sh
npm run eval:models -- --live /private/path/evaluation-config.json
npm run eval:models -- --grade .local/p6-models-UUID.json /private/path/ratings.json
```

首次配置须先核对所选供应商价格和可接受预算。工具复用产品 `streamModel` 和 `compilePrompt`，保存日期、配置模型 ID、语料 SHA、编译器与 prompt hash、输出、usage、首 token/完成耗时；温度未设置，明确记录供应商默认。仅使用合成剧情，不导入真实用户历史。报告不含 Key 或隐藏推理。中途失败的报告保留预留与未知状态；重跑是新的一次预算，不能当作免费恢复。

评分文件为数组，每条 `key` 是 `model-a/S01/1` 这样的配置/剧本/重复编号，需提供 `reviewer`、引用具体回答的 `notes`、四个 1–5 整数分 `voice/behavior/distinction/continuity` 和 `critical_failure` 布尔值。每份三轮 transcript 必须且只能有一条人工评分。每个配置均分至少 4；身份串线、秘密泄漏或无证据事实等严重错误直接失败，不能靠平均分抵消。工具不代替权限路径测试，也不以模型“没说出来”证明输入隔离。

## 候选包与升级

```sh
npm run release:prepare
docker build -t echo2-server:0.6.0-local .
```

候选包在 `.local/releases/`：源码与部署资料、依赖锁文件、逐文件 SHA-256、协议/schema/版本、未通过门槛及归档校验和。内容指纹独立于 Git；当前仓库没有提交时仍能定位准确输入。包装器拒绝符号链接和常见私钥/凭据文件，不包含 `.local`、构建缓存、`.git` 或真实 `.env`。这不是公开发布，也不选择许可证；首次公开发行仍需用户决定许可证和渠道。

P5→P6 执行 `006_snapshot_pages.sql`；REST v1 的分页响应/水位/有效期不变，Apple 旧客户端可继续使用。迁移只增加 nullable 数量字段和分块表；保留完整 `records` 供 P5 回退读取。旧程序创建的快照走兼容路径，删除父快照级联删除分块，遗忘/恢复仍会使快照失效。性能取舍是十分钟快照会额外存一份分块数据。升级前备份，API/Worker 使用同一版本，依 [恢复指南](recovery.md) 操作。
