# 12：Subagent 与 Worker Workflow——让两个 child 协作

> 一句话目标：用真实 `SubagentRuntime + spawn-in-process + WorkerThreadWorkflowEngine` 串联 plain child 与 structured child，并观察上下文、结构化输出、双层生命周期、失败和有界清理边界。

- 上一章：[11 MCP bridge](../s11_mcp_bridge/)
- API Key：不需要
- 本章核心增量：从单 Agent / 外部工具走到 holder-owned 的多 Agent 编排
- 下一章：[13 综合项目](../s13_capstone/)

这一章不再只让一个 AgentLoop 独自工作。我们会让一个真实的 worker script 先启动 `plain child` 整理候选摘要，再启动 `structured child` 给出发布门禁结论，最后由脚本汇总两份结果。

你会同时观察两套生命周期：

- `workflow/*` 回答“整段编排运行到哪里”；
- `subagent/*` 回答“每个真实 child 何时发布、何时结束”。

课程固定使用 DeepSeek Harness `0.1.1-rc.2`，对应上游 commit `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`。

## 问题

到第 11 章为止，我们已经能让一个 agent 调工具，也能通过 MCP 接入外部能力。但有些任务天然适合拆开：一个 child 收集事实，另一个 child 根据事实做结构化判断，最后再合并结果。

如果只写两个普通函数，会漏掉几个 Agent 系统真正困难的部分：

- child 应该看到 parent 的哪些上下文？
- plain text 与 JSON Schema 结果如何区分？
- child failure 应该结束整个 workflow，还是只变成一个空结果？
- workflow 与 subagent 的事件如何配对？
- worker 和 child 结束后，谁负责释放资源？
- worker thread 与 `node:vm` 能不能当作不可信代码沙箱？

本章用一个小而完整的“发布候选检查”回答这些问题。

## 先认识十一个基本概念

### 1. `parent Agent`

Workflow 不是无主运行。`WorkflowStartRequest.parent` 指明这次编排代表哪个在线 Agent 执行。每个 child 的 lineage、工作目录以及默认 provider/model 都从这个 parent 解析。

这里的 parent 还会先完成一个真实轮次，写入标记 `parent-only: release-window-17`。后面我们直接检查 LLM 请求，证明这个标记没有进入 spawn child 的 transcript。

### 2. Subagent 与 `SubagentRuntime`

Subagent 是被 parent 委派一次独立工作的 child Agent。`SubagentRuntime` 是能力 seam：调用方只面对 `ctx.subagents`，不需要知道 child 最终运行在当前进程、另一个进程，还是远程传输后面。

`SubagentRuntime` 负责 provider 注册、请求校验、发布边界和 `subagent/start` / `subagent/end` 事件。它不是具体的模型实现，也不会永久持有所有 child run。

所有权会发生一次明确转移：provider 在 `start()` Promise 兑现前拥有创建事务；发布成功后返回 caller/holder-owned 的 `SubagentRun`。本章中真正持有并 dispose child run 的是 workflow host 内的 `WorkerRun`。

### 3. provider

provider 是 Subagent seam 后面的具体实现。本章显式注册 `s12-course-spawn`，再让 workflow engine 把每次 `agent()` 路由到它。

具名 provider 的价值是把“编排脚本想委派工作”与“child 到底怎么启动”分开。换 provider 时，脚本的 `agent()` 语义可以保持不变。

### 4. `spawn-in-process`

`spawn-in-process` 在当前 Node 进程中创建一个全新的 child Agent 和 child Session，并用真实 AgentLoop 驱动一次任务。

它继承 parent 的 cwd、lineage 和默认 provider/model，但不复制 parent transcript。child 收到的是本次 `agent(prompt)` 的任务内容，不是 parent 的整段聊天记录。

“同进程”也不等于“继承权限”。rc.2 的共享 driver 会固定委派时显式设置的 sandbox override 与 `approval: never`，但 parent 的工具过滤器、作用域所有权或同一 cwd 不能被理解成一份自动的权限授予。生产部署仍要显式定义 sandbox、approval、tool filter 与 provider policy。

### 5. `plain child`

脚本调用 `agent(prompt)` 且不提供 schema 时，启动的是本章所说的 `plain child`。成功结果是 child 最后一条有效 assistant 输出拼成的文本。

主实验中的第一个 child 返回：

```text
候选摘要：测试通过，变更说明齐全。
```

这段文本随后进入第二个 child 的 prompt，数据依赖发生在 worker script 内，不会自动写回 parent transcript。

### 6. `structured child` 与 `structured_output`

脚本调用 `agent(prompt, { schema })` 时，spawn driver 会只在这个 child 的作用域里注册 `structured_output` 工具和对应系统提示。

模型必须调用 `structured_output`，参数还必须通过请求 schema。只有权威 `tools/result` 成功后，driver 才提交结构化值。普通 prose 即使语言上“像答案”，也不算结构化结果。

因此：

- `plain child` 的请求看不到 `structured_output`；
- `structured child` 的请求能看到带本次 schema 的 `structured_output`；
- child dispose 后，这项注册随 child Fiber 一起消失，不污染全局 ToolRuntime。

### 7. `WorkerThreadWorkflowEngine`

`WorkerThreadWorkflowEngine` 是 `ctx.workflowEngine` 的一个真实实现。每次 run 都创建一个 Node worker thread；脚本在 worker 中执行，child Agent 仍留在宿主进程，二者通过消息协议连接。

worker 的主要作用是隔离同步 CPU 工作、避免脚本自旋阻塞宿主事件循环，并允许宿主最终终止 worker。它和内部的 `node:vm` 都不是安全沙箱。模型生成的不可信脚本仍需要进程、容器或其它真正的安全边界。

### 8. Workflow script 与 `agent()` / `phase()` / `log()`

脚本正文是带 top-level await 的 JavaScript body，能使用几个受控 hook：

- `agent()`：向宿主请求一个 subagent；
- `phase()`：切换观察用阶段，不形成执行屏障；
- `log()`：发出观察用叙述；
- `args`：读取宿主传入的普通 JSON 数据。

本章不让模型动态写脚本，而是使用一段可审查、可复现的原创固定脚本。引擎仍会在真实 worker 中解析并执行它。

### 9. 两套生命周期事件

Workflow 这一层有：

- `workflow/start` ↔ `workflow/end`：按 workflow run id 配对；
- `workflow/agent-start` ↔ `workflow/agent-end`：按从 1 开始的 `seq` 配对。

Subagent 这一层有：

- `subagent/start` ↔ `subagent/end`：按独立的 subagent run id 配对。

两套事件使用不同的 run id；要把某次 `agent()` 与真实 child 对上，应比较共同的 `childId`。这些事件只用于观察，不提供运行控制权。

### 10. `WorkflowRun`、holder 与 `dispose()`

`ctx.workflowEngine.start()` 返回 holder-owned 的 `WorkflowRun`：

- `result` 永不 reject，以 `completed`、`cancelled` 或 `error` 表达终态；
- `cancel()` 请求停止；
- 调用方无论成功失败都必须调用 `dispose()`。

等待 `result` 只说明结果已经结算，不等于 worker 与所有 child 都完全停稳。`dispose()` 会在 `disposeGraceMs` 的有界窗口内等待 result 与 child quiescence，随后终止 worker，并继续向幸存 child 发起清理；慢 provider 的最终释放可能超过这个窗口，不能把它写成无条件等待到完全停稳。本章正常场景观察到两个 child 都已移除。每条场景都在 `finally` 兜底 dispose run，之后再 dispose parent handle 和 root context。

### 11. `null`、fatal error 与 `maxTotalAgents`

Workflow 区分两类失败：

- 普通 child failure：某次 `agent()` 在脚本中得到 `null`，脚本可以决定继续、跳过或使用回退值；
- workflow fatal error：参数错误、provider 基础设施错误、脚本解析错误或资源上限会结束整个 workflow。

`maxTotalAgents` 是防止脚本无限创建 child 的部署侧后挡板。达到上限时，第二个 `agent()` 不会静默变成 `null`，整个 run 以 `error` 结束。

## 你会交付什么

本章已有以下可检查产物：

```text
s12_subagent_workflow/
├── README.md
├── notes.md
├── src/
│   ├── demo.ts
│   ├── subagent-workflow-lab.ts
│   └── workflow-harness.ts
└── tests/
    ├── chapter-contract.test.ts
    └── subagent-workflow.test.ts
```

- [workflow-harness.ts](src/workflow-harness.ts)：组合真实运行栈并采集两套事件。
- [subagent-workflow-lab.ts](src/subagent-workflow-lab.ts)：一个正向场景和两个负向场景。
- [demo.ts](src/demo.ts)：使用 `node:assert/strict` 的零 Key 演示。
- [subagent-workflow.test.ts](tests/subagent-workflow.test.ts)：行为、配对、失败语义和清理测试。
- [chapter-contract.test.ts](tests/chapter-contract.test.ts)：文档、公开 API、版本和本地链接门禁。
- [notes.md](notes.md)：固定上游研究摘要与课程决策。

## 机制图

```text
host process

parent Agent
  │  transcript 内有 parent-only marker
  │
  └─ ctx.workflowEngine.start()
       │
       ├─ workflow/start
       │
       └────────────── WorkerThreadWorkflowEngine ──────────────┐
                                                                │
              worker thread                                    │
              phase('收集候选')                                │
              log(...)                                         │
              summary = await agent(prompt) ────────────────────┤
                                                                ▼
                                             SubagentRuntime
                                                │ provider route
                                                ▼
                                        spawn-in-process
                                                │
                                                ▼
                                   child Agent + Session + AgentLoop
                                                │
                                                ▼
                                      ScriptedLlmAdapter（唯一替身）
                                                │ plain text
              summary ◀─────────────────────────┘

              phase('形成结论')
              gate = await agent(summary, { schema }) ──────────┐
                                                                ▼
                                   第二个 child + scoped
                                      structured_output
                                                                │ JSON value
              gate ◀────────────────────────────────────────────┘

              return { summary, verdict, checks }
       │
       ├─ workflow/end
       └─ run.dispose()
            ├─ disposeGraceMs 内等待 result / child quiescence
            ├─ 终止 / 回收 worker
            └─ 向窗口后仍存活的 child 发起清理
```

事件配对关系是：

```text
workflow/start(run A) ───────────────────────── workflow/end(run A)

workflow/agent-start(seq 1, child X) ─ workflow/agent-end(seq 1, child X)
subagent/start(run B, child X) ───────────── subagent/end(run B, child X)

workflow/agent-start(seq 2, child Y) ─ workflow/agent-end(seq 2, child Y)
subagent/start(run C, child Y) ───────────── subagent/end(run C, child Y)
```

`A`、`B`、`C` 不是同一种 id；`child X / Y` 才是两层之间的交叉关联键。

## 本章边界

### 哪些是真实上游实现

- Cordis `Context`、plugin 与 Fiber 生命周期；
- AgentRegistry、Session、ToolRuntime、SystemPrompt 与真实 AgentLoop；
- `SubagentRuntime` 与它的 lifecycle observer；
- `spawn-in-process` provider 与 shared in-process driver；
- child-scoped `structured_output` 运行时；
- `WorkerThreadWorkflowEngine`、真实 Node worker 与 host/worker 消息桥；
- `WorkflowRun.result`、cap、事件与有界 dispose；正常场景验证 child quiescence。

### 唯一替身是什么

唯一替身是从第 6 章复用的 `ScriptedLlmAdapter`。它不访问网络，而是按脚本返回公开的 `StreamChunk` 协议。

它只替代“模型会回答什么”，没有替代：

- AgentLoop；
- subagent provider；
- structured tool；
- workflow worker；
- 生命周期事件；
- Agent / Session 注册与释放。

这意味着本章能验证 harness 的编排与资源语义，但不能证明真实模型会稳定完成任务。

### 本章刻意不做什么

- 不使用 API Key，也不测 provider 网络错误、token 成本或模型质量；
- 不让模型动态生成 workflow script；
- 不演示 fork、continuable subagent 或远程 provider；
- 不把 worker thread、`node:vm`、tool filter 或 approval 冒充 OS 级安全沙箱；
- 不把课程完成状态写成学习者已经掌握。

直接依赖固定为：

```text
@deepseek-ai/dsh-subagent@0.1.1-rc.2
@deepseek-ai/dsh-subagent-in-process-driver@0.1.1-rc.2
@deepseek-ai/dsh-subagent-spawn-in-process@0.1.1-rc.2
@deepseek-ai/dsh-workflow@0.1.1-rc.2
@deepseek-ai/dsh-workflow-worker-thread@0.1.1-rc.2
```

## 手把手实验

### 步骤 1：先找到真实组合点

打开 [workflow-harness.ts](src/workflow-harness.ts)，按顺序找到：

```ts
await mountAgentLoopTestDependencies(ctx)
await ctx.plugin(AgentLoop, { agents: [] })
await ctx.plugin(SubagentRuntime)
await ctx.plugin(spawnInProcess, { providerName: COURSE_SUBAGENT_PROVIDER })
await ctx.plugin(WorkerThreadWorkflowEngine, { /* ... */ })
```

回答两个问题：

1. `SubagentRuntime` 为什么不是 child 的具体执行器？
2. `WorkerThreadWorkflowEngine` 为什么需要一个 provider 名称？

建议答案：前者是可替换实现背后的 seam；后者需要把 worker 内的 `agent()` 路由到宿主侧某个真实 child backend。

### 步骤 2：读两阶段脚本

打开 [subagent-workflow-lab.ts](src/subagent-workflow-lab.ts)，找到 `POSITIVE_SCRIPT`。

先不要运行，手工预测：

- `summary` 是字符串还是对象？
- `gate` 是 assistant prose 还是 schema 对应的对象？
- 最终返回值里哪些数据来自 `args`，哪些来自 child？

### 步骤 3：运行 assert demo

在仓库根目录执行：

```bash
pnpm demo:s12
```

如果根脚本尚未接入，也可以直接执行：

```bash
pnpm exec tsx s12_subagent_workflow/src/demo.ts
```

看到 `S12 PASS` 才表示三个场景的运行时断言都成立。

### 步骤 4：检查 transcript 隔离证据

正向场景一共有三次模型请求：

1. parent 自己的一轮；
2. plain child；
3. structured child。

测试会确认：

- 第一次请求含 `PARENT_PRIVATE_MARKER`；
- 后两次请求都不含这个标记；
- 第三个请求含第一个 child 的摘要。

这比只读一句“spawn starts fresh”更强：我们在真实请求对象上验证了边界。

注意，标记只是课程字符串，不是秘密。不要把真实密钥或私人数据放进这种实验。

### 步骤 5：检查 structured tool 的作用域

对比 `plainChildTools` 与 `structuredChildTools`：

- plain child 不含 `structured_output`；
- structured child 包含 `structured_output`；
- 工具参数 schema 就是本次 `agent(..., { schema })` 提供的 schema。
- root/global `ctx.tools.get('structured_output')` 始终为 `undefined`。

这说明工具是 child-scoped composition，不是为了课程提前全局注册的假实现。它不能单独证明 scoped disposer 已运行；本章用 run dispose 后 child Agent 与 Session 都消失作为正常清理证据。

### 步骤 6：检查两套事件

执行行为测试：

```bash
pnpm test:s12
```

或直接运行：

```bash
pnpm exec vitest run s12_subagent_workflow/tests
```

测试不会把两种 run id 混在一起：

- workflow run 由 `workflow/start/end` 的 id 配对；
- child call 由 `workflow/agent-start/end` 的 `seq` 配对；
- subagent run 由 `subagent/start/end` 的 run id 配对；
- workflow 与 subagent 再通过 `childId` 对齐。

### 步骤 7：确认正常场景的 quiescent cleanup

正向 `result` 结算后，场景会调用 `run.dispose()`，再查询真实注册表：

```ts
ctx.agents.get(childId) === undefined
ctx.sessions.get(childId) === undefined
```

两个 child 都消失，而 parent 仍在，说明 workflow holder 只释放自己拥有的 child，没有误删 parent。

这是本章守约 provider 在 1 秒 `disposeGraceMs` 内完成的观察结果，不是所有慢 provider 都会在 `dispose()` 返回前彻底释放的无限等待承诺。

最后由场景释放 parent handle 和 root context。

### 步骤 8：做一个安全的原创修改

在正向场景第一次 `await run.dispose()` 后、`run = undefined` 前，再加一次：

```ts
await run.dispose()
```

重新运行测试。它应该仍然通过，因为公开 `dispose()` 契约是幂等的。完成观察后恢复文件，避免课程和本地修改混在一起。

不要用“删掉所有 dispose”测试泄漏；那会留下 worker 与 child，且不能形成稳定自动验收。

## 负向实验

### 负向 A：schema child 没调用 `structured_output`

`runMissingStructuredScenario()` 给 child 提供了 schema，但 scripted model 只返回 prose：

```text
我只写了 prose，没有调用 structured_output。
```

真实边界会依次表现为：

```text
child model request = 1 次（没有隐式 re-prompt）
        ↓
subagent/end.stopReason = error
        ↓
workflow/agent-end.outcome = failed
        ↓
worker script 的 gate = null
        ↓
脚本显式处理 null 后正常 return
        ↓
workflow/end.stopReason = completed
```

这不是自相矛盾。child 失败是局部事实；脚本正确处理了局部失败，所以整个 workflow 仍能完成。

可以临时把脚本中的 null 分支删掉并直接访问 `gate.verdict`。此时脚本会因访问 `null` 而使 workflow 变成 `error`。观察完成后恢复。

### 负向 B：第二个 child 越过 agent cap

`runAgentCapScenario()` 的 engine ceiling 是 2，但这次 run 主动降低到：

```ts
maxTotalAgents: 1
```

第一个 child 会真实运行并完成；脚本尝试第二个 `agent()` 时触发 `AGENT_CAP` 语义：

```text
agentsStarted = 1
第二个 subagent/start 不存在
workflow.stopReason = error
error 包含 total agent cap (1) 与 maxTotalAgents
```

cap 是防失控策略，因此属于 fatal workflow error，不是一个可被 `.filter(Boolean)` 悄悄跳过的普通 child failure。

## 预期观察

Demo 的关键输出应类似：

```text
S12 PASS: real worker workflow drove plain + structured spawn children
positive: completed -> agents=2 -> children=2 -> parentTranscriptLeaked=false -> childrenRemaining=0
missing structured_output: requests=1 -> script={"scriptObserved":"null"} -> workflow=completed
agent cap: agents=1 -> error -> WorkflowError: this run reached its total agent cap (1) ...
```

自动测试应覆盖：

```text
正向结果：completed / agentsStarted=2
请求隔离：parent marker 不进入两个 child
工具作用域：只有 structured child 看见 structured_output
事件配对：workflow 1 对、agent 2 对、subagent 2 对
资源释放：run.dispose 后 child Agent 与 Session 都不存在
缺失结构化输出：1 次请求 / child error / script null / workflow completed
agent cap：只启动 1 个 child / workflow error
```

## 对照真实源码

以下链接全部固定到本章上游 commit，不使用浮动分支或行号：

- [`SubagentRuntime` seam 与事件](https://github.com/deepseek-ai/deepseek-harness/tree/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/subagent/subagent)
- [`spawn-in-process` provider](https://github.com/deepseek-ai/deepseek-harness/tree/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/subagent/subagent-spawn-in-process)
- [共享 in-process driver 与 `structured_output`](https://github.com/deepseek-ai/deepseek-harness/tree/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/subagent/subagent-in-process-driver)
- [`WorkflowEngine` seam](https://github.com/deepseek-ai/deepseek-harness/tree/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/workflow/workflow)
- [`WorkerThreadWorkflowEngine`](https://github.com/deepseek-ai/deepseek-harness/tree/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/workflow/workflow-worker-thread)
- [上游真实 in-process integration test](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/workflow/workflow-worker-thread/tests/integration.spec.ts)

阅读时重点对照四件事：

1. `SubagentRuntime.start()` 在 provider 真正发布 child 后才发 `subagent/start`；
2. structured capture 只在权威工具结果成功后提交；
3. worker host 如何把 child result 的失败映射为 `null`，把基础设施错误保留为 fatal；
4. `WorkflowRun.dispose()` 如何汇合取消、child dispose 与 worker terminate。

## 验收

### 自动验收命令

```bash
pnpm run lint
pnpm run typecheck
pnpm test:s12
pnpm demo:s12
```

### 行为验收清单

- [ ] 能说清 `SubagentRuntime` seam 与 `spawn-in-process` provider 的分工。
- [ ] 能解释为什么 spawn child 不复制 parent transcript。
- [ ] 能在请求里证明 `structured_output` 只属于 schema child。
- [ ] 能用 `seq`、subagent run id 与 `childId` 分别配对事件。
- [ ] 能解释 child `error`、脚本里的 `null` 与 workflow `completed` 为什么能同时成立。
- [ ] 能解释 `maxTotalAgents` 为什么是 fatal policy。
- [ ] 能说明等待 `result` 后为什么仍必须调用 `dispose()`。
- [ ] 能说明 worker thread 与 `node:vm` 为什么不是安全沙箱。
- [ ] Demo、行为测试、章节契约、typecheck 与 lint 全部通过。

### 结论口径

- `Pass`：自动检查全过，能根据 trace 解释正向与两个负向边界，并完成一次安全原创修改。
- `Pass with fixes`：代码可运行，但仍把两套 run id、`null` 语义、权限或 dispose 所有权混在一起。
- `Not yet`：只读 README，没有运行 artifact；或 child / worker 仍残留；或把 scripted model 说成真实模型调用。

本章代码建设完成不等于学习者已经 `Pass`。个人掌握状态要等亲手实验与复述后再记录。

## 教学简化与生产边界

| 本章做法 | 生产环境还要补什么 |
| --- | --- |
| 固定脚本串行启动两个 child | 动态脚本生成、schema 审核、脚本版本与回归集 |
| `ScriptedLlmAdapter` 是唯一替身 | 真实 provider、密钥、限流、重试、token 与成本观测 |
| `spawn-in-process` | 进程崩溃边界、远程 provider、持久化与跨进程租约 |
| `maxTotalAgents` | 并发、总 token、超时、队列、租户与预算联合限制 |
| 观察 `workflow/*` / `subagent/*` | trace 持久化、指标、告警与 UI 关联 |
| child-scoped `structured_output` | schema 版本、兼容性、业务校验与结果审计 |
| finally 中有界 dispose | host shutdown、宽限期后的慢 provider 追踪、强制取消与泄漏监控 |

还要保留三个安全判断：

1. worker thread 保护宿主事件循环，不隔离进程权限；`node:vm` 不是安全沙箱。
2. spawn 不复制 transcript，也不自动授予 parent 权限；tool visibility、sandbox enforcement 与 approval decision 是不同层。
3. lifecycle event 是 observe-only；控制权仍在 holder 的 `cancel()` / `dispose()` 和 provider 的 signal 契约中。

## 上游观察卡

### 观察 1：integration test 的 “nudge” 描述与当前 driver 契约不一致

固定上游的 `workflow-worker-thread/tests/integration.spec.ts` 把缺失结构化输出的用例描述为 “nudges exhausted”，并提供两段 prose response；但 `subagent-in-process-driver` 的专门测试和 README 明确规定：clean finish without capture 会立即变成 `error`，不做 re-prompt。

本章实测只发生 1 次模型请求，第二段备用 response 没有被消费。

可贡献的最小上游改动：重命名 integration case，删除未使用的第二段 response，并补 `adapter.requests.length === 1`。这是测试表述修正，不改变运行时行为。当前仅记录候选，尚未提交 issue 或 PR。

### 观察 2：fatal worker error 文本包含本地绝对 stack path

`AGENT_CAP` 场景的 `WorkflowResult.error` 除稳定消息外，还携带 worker stack；发布包运行时会出现本地 `node_modules/.pnpm/.../worker.cjs` 绝对路径。课程只断言稳定子串，并在 demo 中只输出第一行。

这可能影响日志可移植性与对外错误最小化，值得进一步确认消费方是否会原样暴露。若准备上游贡献，应先补一个 published-package reproduction，再讨论保留 debug stack 与返回稳定 message 的分层方式。当前不把它直接判定为安全漏洞。
