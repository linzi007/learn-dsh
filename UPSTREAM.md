# 上游基线与兼容性

最后验证：2026-08-24

## 固定基线

| 项目 | 值 |
| --- | --- |
| 上游 | `https://github.com/deepseek-ai/deepseek-harness` |
| 版本 | `0.1.1-rc.2` |
| commit | `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e` |
| 默认分支 | `master` |
| 上游许可证 | MIT（个别 vendored/native 子目录可能不同） |
| 课程直接依赖 | 以根目录 `package.json` 与 `pnpm-lock.yaml` 为准，所有 DSH 包固定为 `0.1.1-rc.2` |

DeepSeek Harness 仍处于 developer preview，可能自由重命名或产生破坏性变化。本课程的结论只对表中基线负责。

## 第 1 章源码锚点

- [Cordis 生命周期官方教程](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/docs/cordis-tutorial/02-lifecycle-and-effects.zh.md)
- [`Context` 与根 fiber](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/vendor/cordis/src/context.ts)
- [`Fiber.effect()` 与 `Fiber.dispose()`](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/vendor/cordis/src/fiber.ts)
- [Cordis 包定义](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/vendor/cordis/package.json)

## 第 2 章源码锚点

- [Cordis Service 官方教程](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/docs/cordis-tutorial/03-services.zh.md)
- [`Service` 注册具名能力](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/vendor/cordis/src/service.ts)
- [`inject` 与 Plugin registry](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/vendor/cordis/src/registry.ts)
- [Fiber 的依赖刷新与重载](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/vendor/cordis/src/fiber.ts)

## 第 3 章源码锚点

- [Session 子系统说明](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/docs/subsystems/session.zh.md)
- [`Session.create()`、`events`、`seq` 与 `append()`](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/core/session/src/index.ts)
- [`SessionEventMap` 与 `SessionEvent`](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/core/session/src/types.ts)
- [`snapshotJsonValue()` 的 lossless JSON 边界](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/core/session/src/json.ts)
- [Session 行为测试](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/core/session/tests/session.spec.ts)

## 第 4 章源码锚点

- [Session projection 子系统说明](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/docs/subsystems/session-projection.zh.md)
- [`ProjectionDefinition` 与 `SessionProjectionRegistry`](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/session/session-projection/src/index.ts)
- [Projection 类型扩展表](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/session/session-projection/src/types.ts)
- [Projection registry 行为测试](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/session/session-projection/tests/registry.spec.ts)

## 第 5 章源码锚点

- [Tools 子系统说明](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/docs/subsystems/tools.zh.md)
- [`ToolRuntime`、执行事件与 guard](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/core/tools/src/index.ts)
- [`defineTool` 与 schema DSL](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/core/tools/src/schema.ts)
- [Tools 行为测试](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/core/tools/tests/tools.spec.ts)

## 第 6 章源码锚点

- [`AgentLoop` Service 与 Agent factory](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/core/agent-loop/src/index.ts)
- [单个 Turn / Step 的驱动逻辑](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/core/agent-loop/src/agent.ts)
- [模型工具调用到 `tool/result` 的桥接](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/core/agent-loop/src/tool-calls.ts)
- [AgentLoop 行为测试](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/core/agent-loop/tests/agent-loop.spec.ts)

## 第 7 章源码锚点

- [`ApprovalService`、request 路由与审计事件](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/interaction/user-approval/src/index.ts)
- [`ApprovalOutcome` 与 request 类型](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/interaction/user-approval/src/types.ts)
- [`tools/pre-execute` 与 `PreToolDecision`](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/core/tools/src/index.ts)
- [Approval 行为测试](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/interaction/user-approval/tests/user-approval.spec.ts)

## 第 8 章源码锚点

- [JSONL backend、plaintext append、`readRaw` 与 repair commit](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/session/session-persistence-jsonl/src/index.ts)
- [JSONL scanner 与 committed-region 判定](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/session/session-persistence-jsonl/src/format.ts)
- [`PersistenceCoordinator` 的恢复、publication 与 write-behind](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/session/session-persistence/src/coordinator.ts)
- [`interruptedTurnClosers` 修复顺序](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/core/session/src/repair.ts)
- [JSONL persistence 行为测试](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/session/session-persistence-jsonl/tests/jsonl.spec.ts)

## 第 9 章源码锚点

- [`JobStart`、`JobHooks`、状态与结果类型](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/jobs/jobs/src/types.ts)
- [`JobRegistry` Service Definition 与公开 API](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/jobs/jobs/src/index.ts)
- [`LocalJobRegistry` 状态机与 owner cleanup](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/jobs/jobs-local/src/index.ts)
- [`tool-jobs` 的 controller 与模型工具投影](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/jobs/tool-jobs/src/index.ts)
- [Local jobs 行为测试](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/jobs/jobs-local/tests/jobs.spec.ts)

## 第 10 章源码锚点

- [`CompactionEngine` Service API 与 durable event map](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/compaction/compaction/src/index.ts)
- [checkpoint source 与 predicate](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/compaction/compaction/src/checkpoint.ts)
- [`BasicCompactionEngine` 入口与策略](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/compaction/compaction-basic/src/index.ts)
- [范围选择、事务、replacement 与失败分类](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/compaction/compaction-basic/src/region.ts)
- [`TokenMeter` 的 replay-aware measurement](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/llm/token-meter/src/index.ts)
- [Manual compaction 行为测试](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/compaction/compaction-basic/tests/manual-compaction.spec.ts)

## 第 11 章源码锚点

- [`mcp-client` namespace plugin 与配置](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/mcp/mcp-client/src/index.ts)
- [连接、generation、reconnect 与 dispose](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/mcp/mcp-client/src/connection.ts)
- [raw/public naming、discovery、call 与结果映射](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/mcp/mcp-client/src/tools.ts)
- [stdio / Streamable HTTP transport factory](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/mcp/mcp-client/src/transport.ts)
- [MCP client 真实协议测试](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/mcp/mcp-client/tests/mcp-client.e2e.ts)

## 第 12 章源码锚点

- [`SubagentRuntime` seam 与事件](https://github.com/deepseek-ai/deepseek-harness/tree/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/subagent/subagent)
- [`spawn-in-process` provider](https://github.com/deepseek-ai/deepseek-harness/tree/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/subagent/subagent-spawn-in-process)
- [共享 in-process driver 与 `structured_output`](https://github.com/deepseek-ai/deepseek-harness/tree/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/subagent/subagent-in-process-driver)
- [`WorkflowEngine` seam](https://github.com/deepseek-ai/deepseek-harness/tree/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/workflow/workflow)
- [`WorkerThreadWorkflowEngine`](https://github.com/deepseek-ai/deepseek-harness/tree/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/workflow/workflow-worker-thread)
- [In-process workflow integration test](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/workflow/workflow-worker-thread/tests/integration.spec.ts)

## 第 13 章源码锚点

- [`FileSystem` seam、`resolve` 与 `contains`](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/fs/fs/src/index.ts)
- [`LocalFileSystem` realpath identity 与 mutation](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/fs/fs-local/src/index.ts)
- [`fs-observation-policy` 的 WeakMap gate](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/fs/fs-observation-policy/src/index.ts)
- [`ToolFs` plugin 组合](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/fs/tool-fs/src/index.ts)
- [`read` 与 `fs/observed`](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/fs/tool-fs/src/read.ts)
- [`edit` 与 `fs/edit-intent`](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/fs/tool-fs/src/edit.ts)

## 兼容策略

1. 课程运行不要求 clone 上游源码。
2. 源码研究使用固定 commit permalink，不使用浮动 `master` 行号。
3. 升级依赖前先运行 `pnpm check:course`，再人工复核源码锚点。
4. 若上游 API 变化，先记录兼容性结果，再决定升级课程基线或保留旧分支。
5. 不把上游 `vendor/`、构建产物或整文件复制进本仓库。

## 环境说明

DeepSeek Harness 整仓要求 Node `^22.19.0 || >=24.0.0` 和 pnpm `11.7.0`。课程沿用这条基线，避免前几章能运行、后续进入真实 DSH 包时再被迫切换环境。
