# 贡献指南

感谢你帮助改进 Learn DSH。v0.1 只维护中文；当前最重要的不是扩张章节数量，而是让现有章节更可理解、更可复现、更可验收。

## 适合提交到本仓库

- 章节中的错误、跳步、失效命令和更清晰的解释。
- 原创 lab、测试、故障注入和架构图。
- 固定上游版本的兼容性验证。
- 独立 DSH 插件的教学示例。

## 应当先去上游 Discussion

- 能在固定 commit 稳定复现、且违背公开约定的 DeepSeek Harness 缺陷。
- 上游文档或公开 API 本身的歧义。
- 需要维护者确认的产品行为。

学习误解、环境问题和没有最小复现的观察，先留在本课程 Issue，不要直接发送给上游。

截至 2026-08-24，DeepSeek Harness 不接受外部 PR，Issues 关闭。不要绕过其贡献政策直接提交上游 PR；请先通过 [GitHub Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions) 沟通。提交前请重新核对固定基线的[上游贡献指南](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/CONTRIBUTING.zh.md)，因为政策可能变化。

## Pull Request 门槛

1. 一次 PR 只解决一个教学问题。
2. 说明受影响章节、学习者会遇到的现象和复现步骤。
3. 行为变化必须增加或修改自动测试。
4. 运行 `pnpm check:course` 并贴出结果。
5. 若引用上游实现，使用 `UPSTREAM.md` 固定 commit 的 permalink。
6. 不提交 API Key、`.env`、真实会话日志、未脱敏截图、`node_modules/` 或上游构建产物。

固定 permalink 只解决来源追踪，不替代许可义务。默认禁止复制上游实质性源码或文档；若确有必要，必须保留原版权和许可证，并同步更新 `THIRD_PARTY_NOTICES.md`。

## 章节完成定义

每章必须具备目标、问题、机制图、源码锚点、可运行 lab、正向与负向实验、预期输出、自动测试、`Pass / Fix / Not yet` 验收，以及教学简化与生产差异。
