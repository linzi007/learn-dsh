# Learn DSH

用可运行、可观察、可验收的实验，逐步学习 DeepSeek Harness 的非官方中文课程。

> [!IMPORTANT]
> 这是社区学习项目，与 DeepSeek 或 DeepSeek Harness 团队没有隶属、合作或背书关系。项目名使用[上游品牌指南](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/BRAND_GUIDELINES.zh.md)建议的缩写 `DSH`。

## 为什么做这个项目

DeepSeek Harness 已经提供 Cordis 入门教程，但从“理解插件”到“构造带 session、tool、permission、persistence、MCP 和 subagent 的 Harness”之间，仍有很长的工程路径。

本课程不追求快速抄出一个大而全的 Agent。每一章只增加一个机制，并完成这个闭环：

```text
提出问题 → 最小机制 → 分步代码 → 运行实验
    → 观察证据 → 失败用例 → 自动验收 → 映射生产源码
```

## 当前进度

版本：`v0.1`。

| 章节 | 状态 | 核心产物 | 是否需要 API Key |
| --- | --- | --- | --- |
| [01 Plugin、Fiber 与 Effect](s01_lifecycle_microscope/) | 可学习 | 基本概念、生命周期与资源泄漏探针 | 否 |
| 02 Service seam | 计划中 | 可替换 Provider / Consumer | 否 |
| 03 Append-only session | 计划中 | 事件追加与不变式 | 否 |
| 04 Projection 与 replay | 计划中 | 可重放的当前状态 | 否 |
| 05 Tool pipeline | 计划中 | 注册、校验和执行流水线 | 否 |
| 06 Keyless agent loop | 计划中 | fake LLM 驱动的完整循环 | 否 |
| 07 Permission 与 sandbox | 计划中 | fail-closed 权限切片 | 否 |
| 08 JSONL persistence | 计划中 | 重启恢复 | 否 |
| 09 Background jobs | 计划中 | 轮询、隔离与取消 | 否 |
| 10 Compaction 与 spill | 计划中 | 小窗口与大结果治理 | 否 |
| 11 MCP bridge | 计划中 | 本地 MCP fixture | 否 |
| 12 Subagent 与 workflow | 计划中 | 确定性委派和汇总 | 否 |
| 13 综合项目 | 计划中 | keyless mini coding harness | 否 |

“计划中”只表示课程路线，不表示已有空壳章节。每章通过完成定义后才会发布。

## 5 分钟开始

前置环境：

- Node.js `22.19.x` 或 `>=24`，推荐 Node 24（Node 23 不在支持范围）
- pnpm `11.7.0`（`packageManager` 已固定）
- Git `2.26+`

安装并运行第 1 章：

```bash
corepack pnpm install
corepack pnpm demo:s01
corepack pnpm test:s01
```

运行全课程检查：

```bash
corepack pnpm check:course
```

核心课程默认不需要模型 API Key。未来若增加真实模型 e2e，它只能是有费用提示的可选验证，不能替代 keyless 验收。

## 学习方式

不要只读 README：

1. 先运行 demo，记录你看到的事件顺序。
2. 阅读本章机制图和最小代码。
3. 主动制造 README 指定的错误。
4. 运行测试，让失败信息证明你的理解是否正确。
5. 恢复实现，通过 `Pass / Fix / Not yet` 验收表。
6. 填写“上游观察卡”，把可复现问题沉淀成课程改进、插件或 Discussion。

## 与上游的关系

课程当前固定 DeepSeek Harness `0.1.1-rc.2` / commit `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`。版本、源码锚点和兼容边界见 [UPSTREAM.md](UPSTREAM.md)。

上游目前不接受外部 PR，Issues 也处于关闭状态；官方鼓励社区插件、博客、操作指南和 GitHub Discussions。因此，课程本身和后续原创插件就是当前可落地的生态贡献。具体分流规则见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 设计原则

- 中文优先；v0.1 不维护翻译和 Web。
- 每章 30-90 分钟，一章只讲一个核心机制。
- 每章至少一个自动测试和一个负向用例。
- 教学实现、mock 与真实生产实现明确分层。
- 不镜像上游源码，只引用固定 commit。
- 先保证纵向切片完整，再增加章节数量。

## License

本项目原创代码和文档使用 [MIT License](LICENSE)。第三方依赖与引用见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
