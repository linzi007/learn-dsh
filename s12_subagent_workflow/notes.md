# Notes: S12 Subagent 与 Workflow 上游研究

## 固定来源

- 上游 commit：`b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`
- `packages/subagent/subagent/`
- `packages/subagent/subagent-spawn-in-process/`
- `packages/subagent/subagent-in-process-driver/`
- `packages/workflow/workflow/`
- `packages/workflow/workflow-worker-thread/`
- 重点行为参考：`packages/workflow/workflow-worker-thread/tests/integration.spec.ts`

## 公开 API 结论

- `SubagentRuntime` 提供具名 provider 注册表与 `subagent/start → subagent/end` 观察事件。
- `spawn-in-process` 创建全新 child session：继承 parent 的 cwd、lineage、provider/model 默认值，但不复制 parent transcript。
- `WorkerThreadWorkflowEngine.start()` 同步拒绝无效 meta、无法解析脚本、未知 provider 与非法每次运行上限；一旦返回 run，结果通过永不 reject 的 `run.result` 表达。
- worker script 的 `agent(prompt)` 返回 child 最终文本；带 `schema` 时只返回 `structured_output` 成功提交的 JSON 值。
- schema child 正常结束但未提交 `structured_output`，driver 会立即把 child stop reason 改为 `error`；没有隐式 re-prompt，workflow 把这类普通 child failure 映射为 `null`。
- `WorkflowRun` 是 holder-owned；无论结果如何都必须 `dispose()`，以等待 child 与 worker 完全停稳。

## 安全与权限边界

- worker thread 隔离同步 CPU 工作，使 worker 可被终止；它不是进程权限隔离。
- `node:vm` 用于塑造脚本 API，不是安全沙箱；逃逸脚本仍可获得 worker 进程权限。
- spawn 不继承 parent transcript，也不把 parent 工具限制当作权限子集；授权边界需由显式 sandbox / approval / provider policy 负责。

## 直接依赖

- `@deepseek-ai/dsh-subagent@0.1.1-rc.2`
- `@deepseek-ai/dsh-subagent-in-process-driver@0.1.1-rc.2`
- `@deepseek-ai/dsh-subagent-spawn-in-process@0.1.1-rc.2`
- `@deepseek-ai/dsh-workflow@0.1.1-rc.2`
- `@deepseek-ai/dsh-workflow-worker-thread@0.1.1-rc.2`

## 课程原创场景

工作流为一次“发布候选检查”：

1. plain child 从任务提示中整理候选摘要；
2. structured child 根据摘要调用 `structured_output`，返回 `{ verdict, checks }`；
3. worker script 汇总两者为普通 JSON；
4. 正向实验同时记录 workflow 与 subagent 两套生命周期，并在 run dispose 后确认 child sessions 已从 AgentRegistry 消失。

负向实验：

- schema child 只输出一次 prose、从未调用 `structured_output`，不会隐式 re-prompt，脚本观察到 `null`；
- 每次运行 `maxTotalAgents: 1`，脚本尝试第二次 `agent()`，整个 workflow 以 fatal `AGENT_CAP` 语义结束，而不是把第二项静默变成 `null`。
