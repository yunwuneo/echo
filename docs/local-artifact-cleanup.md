# 本地验证产物清理记录

日期：2026-10-11（Asia/Shanghai）。用户授权清理 `.local/` 中旧测试结果与重复截图，保留最新有效验证记录。未重新运行测试，未改变既有验收结论。

首轮清理可再生成的 Xcode/Swift 构建产物与依赖缓存，目录从 11.22 GiB 降至 4.85 GiB；本轮再释放约 4.20 GiB，剩余约 0.65 GiB。后续构建会重新产生缓存。

## 保留的测试结果

以下路径相对于 `.local/`；每份结果均保留对应日志，并用 `xcrun xcresulttool get test-results summary` 确认可读取。部分结果包含失败尝试，只采信实施报告已明确列出的通过场景，不把整份结果称为通过。

| 结果包                                      | 保留原因                                                 |
| ------------------------------------------- | -------------------------------------------------------- |
| `dock-v2/ios-core-v2.xcresult`              | 最新行动确认、真实实时状态、离线重启、深色与大字号场景   |
| `dock-v2/ios-follow.xcresult`               | 最新远端遗忘、滚动时状态可达、切换服务器导航清理         |
| `dock-v2/ios-final.xcresult`                | 最新通知设置、导出与冷启动原文路由                       |
| `dock-v2/ios-accessibility.xcresult`        | 最新系统降低透明度场景                                   |
| `dock-v2/ios-verified.xcresult`             | 最新回忆来源与标签搜索导航                               |
| `dock-v2/ios-ax-final.xcresult`             | 最新深色、最大辅助字号、减弱动态效果与裁切审计           |
| `design-refresh/ios-history-final.xcresult` | 浅色私聊、群聊、表单与阅读历史验证                       |
| `design-refresh/ios-follow-final.xcresult`  | 长输入限制验证，尚无更晚的替代结果                       |
| `p5-ios-ui-final.xcresult`                  | 完整四项回归，保留记忆纠正/遗忘/导入与自主回顾的有效证据 |
| `p2-ios-ui-scroll-position.xcresult`        | 分页历史与滚动位置专项记录                               |

精选界面截图保留在 `docs/ui-ux/2026-10-11/design-refresh/` 与 `docs/ui-ux/2026-10-11/dock-v2/`。结果包中的原始附件仍可导出，重复导出的附件目录已删除；这些结果包未被内部裁剪。Mac 最新手测记录 `.local/dock-v2/mac-smoke.md` 与文档截图保留。

## 清理边界与历史引用

已删除其他旧 `.xcresult`、旧截图及重复附件导出目录。历史实施报告中的这些路径是当时的记录，清理后可能已不存在，不再表示原始附件仍留存。小体积历史日志继续保留，失败运行仍是失败，P6 未通过门槛不因清理而视为通过。

本地数据库目录、备份恢复记录、容量/评估 JSON、soak 中断记录、候选源码包及校验文件均保留。没有清理 Docker 容器或卷，没有提交、推送或修改应用代码。

详细删除清单见 `.local/cleanup-20261011/manifest.json`，保留结果包的原始摘要见 `.local/cleanup-20261011/retained-test-summaries.json`；这两份本机记录受 `.gitignore` 排除。
