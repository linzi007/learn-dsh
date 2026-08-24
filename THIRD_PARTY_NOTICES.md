# 第三方依赖与引用

## `@deepseek-ai/cordis`

- 版本：`4.0.1`
- 来源：DeepSeek Harness 仓库的 `vendor/cordis`
- Copyright (c) 2021-present Shigma
- 许可证：MIT
- 许可证原文：[固定基线的 `vendor/cordis/LICENSE`](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/vendor/cordis/LICENSE)
- 用途：第 1 章演示 plugin / effect / fiber 生命周期，第 2 章演示真实 Service / inject seam。

## DeepSeek Harness packages

- `@deepseek-ai/dsh-agent@0.1.1-rc.2`
- `@deepseek-ai/dsh-agent-loop@0.1.1-rc.2`
- `@deepseek-ai/dsh-agent-loop-testkit@0.1.1-rc.2`
- `@deepseek-ai/dsh-compaction@0.1.1-rc.2`
- `@deepseek-ai/dsh-compaction-basic@0.1.1-rc.2`
- `@deepseek-ai/dsh-fs@0.1.1-rc.2`
- `@deepseek-ai/dsh-fs-local@0.1.1-rc.2`
- `@deepseek-ai/dsh-fs-observation-policy@0.1.1-rc.2`
- `@deepseek-ai/dsh-jobs@0.1.1-rc.2`
- `@deepseek-ai/dsh-jobs-local@0.1.1-rc.2`
- `@deepseek-ai/dsh-llm@0.1.1-rc.2`
- `@deepseek-ai/dsh-mcp-client@0.1.1-rc.2`
- `@deepseek-ai/dsh-session@0.1.1-rc.2`
- `@deepseek-ai/dsh-session-persistence-jsonl@0.1.1-rc.2`
- `@deepseek-ai/dsh-system-prompt@0.1.1-rc.2`
- `@deepseek-ai/dsh-tools@0.1.1-rc.2`
- `@deepseek-ai/dsh-tool-fs@0.1.1-rc.2`
- `@deepseek-ai/dsh-user-approval@0.1.1-rc.2`
- `@deepseek-ai/dsh-session-projection@0.1.1-rc.2`
- `@deepseek-ai/dsh-subagent@0.1.1-rc.2`
- `@deepseek-ai/dsh-subagent-in-process-driver@0.1.1-rc.2`
- `@deepseek-ai/dsh-subagent-spawn-in-process@0.1.1-rc.2`
- `@deepseek-ai/dsh-token-meter@0.1.1-rc.2`
- `@deepseek-ai/dsh-workflow@0.1.1-rc.2`
- `@deepseek-ai/dsh-workflow-worker-thread@0.1.1-rc.2`
- 来源：DeepSeek Harness 固定基线中的 `packages/`
- Copyright (c) 2026 DeepSeek
- 许可证：MIT
- 许可证原文：[固定基线的根 `LICENSE`](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/LICENSE)
- 用途：第 3-13 章演示 Session、Projection、Tool、AgentLoop、Approval、JSONL persistence、Jobs、Compaction、MCP、Subagent、Workflow 与 filesystem tools；testkit 只提供无 Key 组合依赖，模型边界仍由课程明确标注的 scripted adapter 代替。

以上列出的生产直接依赖均为 MIT，peer dependency 也由 lockfile 固定；完整生产依赖树另含 BSD-2-Clause、BSD-3-Clause 与 ISC，详见 [v0.4 验证记录](validation/2026-08-24-v04.md)。

## `@modelcontextprotocol/sdk`

- 版本：`1.29.0`
- Copyright (c) Anthropic, PBC
- 许可证：MIT
- 来源：`https://github.com/modelcontextprotocol/typescript-sdk`
- 用途：第 11 章的本地 fixture server 使用官方 SDK 建立真实 MCP stdio / JSON-RPC 协议链路。

## `zod`

- 版本：`4.4.3`
- Copyright (c) 2025 Colin McDonnell
- 许可证：MIT
- 用途：第 4 章为 projection state 和 wire view 提供运行时 schema。

本仓库只声明 NPM 依赖，没有复制 Cordis 或 DeepSeek Harness 的实现文件，也没有把依赖代码打包进仓库。课程文字对上游机制进行原创解释，并通过 `UPSTREAM.md` 中的固定 commit 链接引用来源。若未来发布 bundle、桌面应用或静态制品，必须随产物携带所含第三方软件要求的完整许可证。

`pnpm-lock.yaml` 用于固定依赖版本和完整性哈希；许可证的权威来源是各安装包自带的 `LICENSE` 和 package metadata。
