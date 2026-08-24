# 09：Background jobs——把长任务交还给可控生命周期

> 一句话目标：直接使用真实 `AgentRegistry`、`LocalJobRegistry` 与 `ctx.jobs` 公开 API，让确定性 producer 经历增量读取、有限等待、显式取消、owner 隔离和 Fiber 自动清理。

- 上一章：[08 JSONL persistence](../s08_jsonl_persistence/)
- API Key：不需要
- 本章核心增量：把“一段还没结束的工作”注册为有 id、有状态、有 owner、可读取、可等待、可取消并能随生命周期清理的 background job
- 下一章：[10 Compaction](../s10_compaction/)

## 问题

如果一个工具直接 `await` 十分钟，Agent 在这十分钟里无法把控制权交回模型，也无法继续完成其他独立工作。把 Promise 丢到一旁同样不够，因为宿主还必须回答：

- 后续调用怎样找到这段工作？
- 谁可以读取它，猜到 `course-1` 的人都可以吗？
- “请求停止”和“资源已经释放”是不是同一件事？
- 等待超时或调用方 abort 时，后台工作是否也应被杀掉？
- Agent 或整个 jobs Service dispose 后，谁负责取消并等待遗留工作？
- 流输出怎样保证不会在每次读取时重复？

本章直接组合 `@deepseek-ai/dsh-jobs-local@0.1.1-rc.2`，不另写 Registry。课程只原创一个能被测试显式推进的 producer，以及一个声明“这里存在控制面”的非模型 controller。

## 先认识九个基本概念

### 1. `JobRegistry`：稳定的 Service Definition

`@deepseek-ai/dsh-jobs@0.1.1-rc.2` 定义 `ctx.jobs` 的公共契约：

```ts
ctx.jobs.start(spec)
ctx.jobs.list(caller?)
ctx.jobs.get(id, caller?)
ctx.jobs.read(id, caller?)
ctx.jobs.kill(id, caller?, reason?)
ctx.jobs.wait(id, timeoutMs, caller?, signal?)
ctx.jobs.onJobDone(listener)
ctx.jobs.onJobsChanged(listener)
ctx.jobs.attachController(name)
```

它是抽象 seam，不是可以直接挂载的存储实现。producer 和 controller 依赖这个稳定契约，不依赖某个具体后端 class。

### 2. `LocalJobRegistry`：进程内 Service Provider

`@deepseek-ai/dsh-jobs-local@0.1.1-rc.2` 提供真实 `LocalJobRegistry`：

- 在内存中保存 job record；
- 按 kind 生成 `<kind>-N` id；
- 投影全新的 snapshot，不把内部可变记录交给调用方；
- 执行 owner 授权、等待方释放、首次结算优先和生命周期清理；
- 默认限制每个确切 owner 同时存在十个 `running + stopping` job。

它不提供跨进程持久化，也不实现排队、抢占或 worker 调度。Service Provider 管理的是已经被 producer 启动的工作记录。

### 3. producer：真正拥有执行资源的一方

producer 可以是后台 Bash、subagent、下载器或课程中的确定性任务。它负责：

- 真正开始工作；
- 保存进程、socket、child run 等执行资源；
- 响应取消请求；
- 在资源完全释放后结算 `done`；
- 如果有流输出，返回下一段尚未消费的文本。

Registry 拥有 id、授权和生命周期状态；producer 拥有执行资源。把两者分开，新 producer 就不必重新发明 job id、隔离与 owner cleanup。

### 4. `JobStart`：注册前声明

producer 把一个 `JobStart` 交给 `ctx.jobs.start()`：

```ts
interface JobStart {
  kind: JobKind
  label: string
  outputLimitBytes?: number
  owner?: Agent
  run(): JobHooks
}
```

- `kind` 同时决定 id 前缀。本章通过 declaration merging 增加原创的 `course` kind。
- `label` 是一行可读说明，不应包含秘密。
- `owner` 省略时产生 unowned job；它对所有 caller 开放，直到 jobs Service dispose。
- `run()` 必须同步返回 hooks，而且只能被调用一次。

Registry 会先检查 controller、字段、owner liveness 和并发准入，再调用 `run()`。因此预检失败不会偷偷启动资源，也不会消耗一个 id。

### 5. `JobHooks`：producer 与 Registry 的协作协议

`run()` 返回：

```ts
interface JobHooks {
  cancel(reason?: string): void
  done: Promise<JobOutcome>
  readOutput?(): string
}
```

关键约束：

- `cancel()` 是同步、幂等的“请求停止”，正常返回后必须让 `done` 最终结算；
- `done` 不应 reject，并且只在执行资源已经释放后 resolve；
- 有 `readOutput()` 表示流任务，每次读取消费同一个游标；
- 没有 `readOutput()` 表示 final-output job，终态后从 `JobOutcome.output` 幂等读取最终文本。

所以 job 不是“换了名字的 Promise”。`done` 只是 producer 对完全停稳的承诺；Registry 在它周围增加身份、访问控制、状态、取消入口、等待和清理。

### 6. `JobSnapshot`：调用方看到的新鲜投影

`get()`、`list()`、`read()` 和 `wait()` 返回的 `JobSnapshot` 包含：

```text
id / kind / label / ownerSession?
status / detail?
startedAt / finishedAt?
outputLimitBytes? / reported
```

状态是：

`running` 表示仍在执行，`stopping` 表示已接受取消但尚未完全停稳；
`completed`、`killed` 与 `failed` 是三种互斥终态。

```text
running ────────────────> completed
   │                     killed
   │                     failed
   │
   └─ cancel accepted ─> stopping ─> killed / completed / failed
```

`stopping` 表示取消请求已经被 producer 接受，但资源尚未确认释放。它仍占用并发额度；不能为了启动替代工作就把它假装成终态。

### 7. controller：保证 job 有可用的控制面

`start()` 要求至少一个 controller 能服务该 owner。否则 producer 可能启动一段没有人能收集或停止的工作。

本章的 [`courseJobController`](src/background-jobs-lab.ts) 只做一件事：

```ts
ctx.jobs.attachController('s09-course-lab')
```

它注册在调用 Plugin 的 effect scope 中，Plugin 卸载时自动 detach。controller 名称只是诊断标签，不是权限 token。

本章把它挂在 root/global layer，因此它为所有 owner 提供 admission marker；真正调用 `read/kill/wait` 的仍是课程 host 代码。这个 fixture 不注册 UI 或模型工具。

官方 `@deepseek-ai/dsh-tool-jobs` 也是 controller，但它位于模型侧：注册 `job_output`、`job_list`、`job_kill`，渲染状态并投递完成通知。它**不是 producer**，也没有“启动任意 job”的通用工具；具体 producer 仍然自己调用 `ctx.jobs.start()`。

### 8. owner：授权身份与清理身份

owned job 保存一个真实 `Agent`：

- `read/get/list/kill/wait` 的授权比较 owner 与 caller 的 `SessionId`；
- 并发准入、完成通知和清理绑定确切 `Agent` 对象；
- owner Fiber dispose 会尝试取消该对象仍存活的 job；对守约 producer，它会等待 `done` 后再移除全部 owned snapshots。若 teardown 中的 `cancel()` 自己抛错，只能结束 Registry 记录以避免清理死锁，不能证明底层工作已经释放。

id 是可预测的，例如 `course-1`。安全边界是 owner authorization，不是让 job id 难以猜测。

本章的 [`createLifecycleOnlyAgent()`](src/lifecycle-agent.ts) 使用真实 `Session`、`Inbox`、独立 Fiber 与 `AgentRegistry` identity，但不发送消息也不驱动模型。它只是一项明确标注的 owner-lifecycle fixture，不是一个简化版 AgentLoop。

### 9. `reported`：终态是否已被控制路径认领

`reported` 不是第六种状态。它用于避免已经被读取、等待或显式 kill 的终态又触发一次冗余模型通知：

- live job 的普通读取与 wait timeout 不会设置它；
- `kill()` 成功会设置它；
- terminal read 或得到 terminal snapshot 的 wait 会设置它；
- owner/service teardown 对仍存活且进入取消路径的记录会先设置它，因为正在销毁的 owner 不应再被完成通知唤醒；已经 terminal 的记录会直接移除。

本章会观察这个字段帮助理解真实结果，但不会围绕它另造通知系统。模型通知属于 `dsh-tool-jobs` 的 Consumer 职责。

## 你会交付什么

完成本章会得到五类证据：

1. `course-1` 从 `start` 进入 `running`，两次 `read` 证明流输出是消费式的。
2. 有界 `wait` 超时返回 `running` snapshot，不停止 producer。
3. `kill(reason)` 先得到 `stopping`，随后在 producer `done` 结算后得到 `killed`。
4. `course-2` 随 owner Fiber dispose 自动收到 `owner disposed`，cleanup 等待结束并移除记录。
5. 自动测试证明 controller preflight、owner isolation、wait abort、throwing cancel 和 service teardown 的失败边界。

对应文件：

- [`src/deterministic-job.ts`](src/deterministic-job.ts)：课程原创、手动推进的 `course` producer。
- [`src/lifecycle-agent.ts`](src/lifecycle-agent.ts)：只提供真实 owner identity/lifecycle 的 fixture。
- [`src/background-jobs-lab.ts`](src/background-jobs-lab.ts)：真实 composition 与两条 job lifecycle。
- [`src/demo.ts`](src/demo.ts)：带 `assert` 的可观察主线。
- [`tests/background-jobs.test.ts`](tests/background-jobs.test.ts)：正向、隔离、取消和 teardown 验收。

## 机制图

```text
DeterministicJobProducer              courseJobController
  owns buffer / cancel / done           attachController()
             │                                  │
             └──── JobStart + JobHooks ─────────┤
                                                v
                                      ctx.jobs.start()
                                                │
                                      LocalJobRegistry
                            id / status / auth / waiters / cleanup
                              │          │             │
                              │          │             ├─ kill(reason)
                              │          │             ├─ owner Fiber dispose
                              │          │             └─ service dispose
                              │          │                     │
                              │          └─ wait ──> settled waiter
                              │                                │
                              └─ read ──> producer.readOutput()│
                                                               v
                                                      producer.cancel()
                                                               │
                                                               v
                                                      done settles after cleanup
                                                               │
                                                               v
                                                terminal snapshot / remove
```

Registry 不执行课程任务，controller 也不执行课程任务。箭头回到 producer，正是为了保留资源所有权。

## 本章边界

真实 composition：

```text
Context
  ├─ AgentRegistry
  ├─ LocalJobRegistry       → ctx.jobs
  ├─ courseJobController    → attachController only
  └─ lifecycle-only Agent   → Session + Inbox + owner Fiber
           └─ DeterministicJobProducer → ctx.jobs.start(JobStart)
```

固定公开包：

- `@deepseek-ai/cordis@4.0.1`
- `@deepseek-ai/dsh-agent@0.1.1-rc.2`
- `@deepseek-ai/dsh-session@0.1.1-rc.2`
- `@deepseek-ai/dsh-jobs@0.1.1-rc.2`
- `@deepseek-ai/dsh-jobs-local@0.1.1-rc.2`

有意不进入：

- 真实模型、provider、API Key 与模型自行调用 job tools；
- `dsh-tool-jobs` 的完成通知、wake budget、prompt 与结果截断；
- AgentLoop、真实 turn/step 和 durable transcript；
- Bash process、PTY、subagent 或网络请求；
- 持久化 job、跨进程恢复、队列、优先级、重试和 scheduler；
- 多个独立流读取游标；真实 Registry 当前只有一个消费游标。

## 手把手实验

### 第 0 步：先预测

运行前写下答案：

1. 第一次 `read()` 返回 `alpha\nbeta\n` 后，第二次会返回相同文本还是空字符串？
2. `wait(..., 1)` 超时时，snapshot 和 producer 各是什么状态？
3. `kill()` 返回时已经完全释放资源了吗？
4. `course-1` 能否被一个不同 SessionId 的 Agent 读取？
5. owner Fiber dispose 是否只取消 live job，终态历史是否也会被移除？

### 第 1 步：定位三种角色

打开 [`src/background-jobs-lab.ts`](src/background-jobs-lab.ts)，分别找到：

1. `AgentRegistry` 与 `LocalJobRegistry`；
2. 只调用 `attachController()` 的 `courseJobController`；
3. 调用 `root.jobs.start()` 的 scenario。

用一句话复述：Provider、controller 和 producer 分别拥有哪部分责任。

### 第 2 步：检查 producer contract

打开 [`src/deterministic-job.ts`](src/deterministic-job.ts)，按顺序定位：

1. `JobKindMap` declaration merging；
2. `JobStart.spec`；
3. `cancel`；
4. `completion` / `done`；
5. `readOutput()`；
6. first-settlement guard。

`push()` 与 `complete()` 是测试 driver 的控制柄，不是模型工具。代码里没有 timer、queue 或 worker。

### 第 3 步：走 Job A 的显式控制路径

在 `runBackgroundJobsScenario()` 中沿着：

```text
start course-1
  → push two lines
  → read: two lines
  → read: empty
  → wait timeout: running
  → kill(reason): requested
  → get: stopping
  → wait: killed
```

注意 `kill()` 先调用 producer `cancel()`，成功返回后 Registry 才把 record 改为 `stopping`。本章 producer 同步 resolve `done`，但 Promise continuation 仍在稍后的 microtask 提交终态，所以可以稳定观察到中间状态。

### 第 4 步：走 Job B 的 owner cleanup 路径

同一个 scenario 再启动 `course-2`，不显式 kill，直接 dispose owner Fiber：

```text
course-2 running
  → owner Fiber dispose
  → cancel('owner disposed')
  → await producer done
  → remove course-1 and course-2 snapshots
```

一个 job 的第一次取消只能来自显式 kill 或 teardown 之一，不可能同时证明两种原因。因此主线使用两个连续 job，而不是伪造一条不可能的状态历史。

### 第 5 步：运行带断言的 demo

```bash
corepack pnpm demo:s09
```

[`src/demo.ts`](src/demo.ts) 不依赖人眼判断日志；id、输出、状态、取消原因和最终空列表都由 `node:assert/strict` 验证后才打印 PASS。

### 第 6 步：运行自动测试

```bash
corepack pnpm test:s09
```

测试分别验证主线、controller preflight、owner isolation、wait abort、取消抛错和 service dispose。

### 第 7 步：做自己的正向修改

只修改 [`src/background-jobs-lab.ts`](src/background-jobs-lab.ts) 中 Job A 的 `push()` 文本，例如增加：

```ts
explicit.push('gamma\n')
```

同步更新 demo 与测试的预期后运行：

```bash
corepack pnpm test:s09
corepack pnpm demo:s09
```

验收重点不是行数，而是第一次 read 得到全部未读文本、第二次 read 仍为空。

## 负向实验

### 负例 A：移除唯一 controller

临时注释 [`src/background-jobs-lab.ts`](src/background-jobs-lab.ts) 中：

```ts
ctx.jobs.attachController('s09-course-lab')
```

运行：

```bash
corepack pnpm test:s09
```

预期主线在 producer 启动前失败，错误包含：

```text
background jobs unavailable: no job controller serves this agent
```

恢复代码。专门的 no-controller 测试还会证明失败 producer 的 `started === false`，随后重新附加 controller 得到的第一个 id 仍是 `course-1`。

### 负例 B：用 Bob 操作 Alice 的可预测 id

阅读 owner isolation 测试。Alice 得到 `course-1` 后，Bob 分别尝试 `read/kill/wait`：

```text
job course-1 belongs to another session
```

同时 `list(bob)` 是空列表，不能泄漏 Alice 的 label。不要把 job id 改成随机数来“修复”这个实验；授权检查才是边界。

### 负例 C：把 wait abort 误当成 job cancel

测试先创建一个长 wait，再立即 abort 它。预期只有 wait reject：

```text
wait aborted
```

随后 `get(id)` 仍是 `running`，producer 没收到任何 cancel。调用方停止等待，不代表后台工作失去价值。

### 负例 D：producer 的 `cancel()` 抛错

`cancelError: 'cancel boom'` 故意违反正常取消路径。真实 Registry 会传播错误，并保持：

```ts
{ status: 'running', reported: false }
```

它不会谎称 `stopping` 或 `killed`。测试最后由宿主调用 `complete()` 收回资源，避免故障探针污染 teardown。

完成所有负例后恢复代码，再运行：

```bash
corepack pnpm test:s09
corepack pnpm demo:s09
```

## 预期观察

demo 的稳定输出是：

```text
S09 PASS: real LocalJobRegistry completed both lifecycle paths
A: course-1 -> running -> read(delta) -> wait(timeout) -> stopping -> killed
B: course-2 -> running -> owner Fiber dispose -> owner disposed -> remaining=0
```

应能解释这些事实：

- id 由真实 Provider 分配，不由 producer 自己猜测；
- 第二次流读取为空，证明 Registry 调用的是 producer 拥有的单一消费游标；
- wait timeout 是成功观察，不是 job failure；
- `stopping` 与 terminal 分开，防止释放资源前提前腾出容量；
- owner dispose 会等待守约 producer 的 `done`，然后移除终态与存活记录；
- service dispose 对守约的 unowned producer 转发 `jobs service disposed`，并等待其 `done` 结算。

## 对照真实源码

课程固定上游 commit：`b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`。以下链接固定 commit，symbol 可能随未来版本移动，因此不绑定行号：

- [`JobStart`、`JobHooks`、`JobOutcome`、`JobSnapshot` 与状态词汇](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/jobs/jobs/src/types.ts)
- [`JobRegistry` Service Definition 与九个公开方法](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/jobs/jobs/src/index.ts)
- [`LocalJobRegistry.start/read/kill/wait/settle/owner cleanup/service teardown`](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/jobs/jobs-local/src/index.ts)
- [上游可控 producer、controller scope、隔离与清理测试](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/jobs/jobs-local/tests/jobs.spec.ts)
- [`dsh-tool-jobs` 怎样附加 controller 并投影三个模型工具](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/jobs/tool-jobs/src/index.ts)

建议沿这条调用链阅读：

```text
DeterministicJobProducer.spec
  → JobRegistry.start contract
  → LocalJobRegistry.start preflight + registration
  → read / wait / kill
  → producer done.then
  → LocalJobRegistry.settle
  → owner Fiber effect
  → disposeOwned / cancelForTeardown
```

不要复制实现文件。课程代码只实现一个新的 producer，并通过公共 `ctx.jobs` seam 观察上游行为。

## 验收

运行：

```bash
corepack pnpm demo:s09
corepack pnpm test:s09
corepack pnpm check:course
```

| 检查项 | Pass | Fix | Not yet |
| --- | --- | --- | --- |
| 能解释 Registry、Provider、producer 与 controller 的责任边界 | 能独立复述并在代码中指出对应对象 | 概念能说出但仍混淆资源 owner | 把四者当成同一个“任务类” |
| 能解释 `JobStart` / `JobHooks` | 能说明 preflight、同步 cancel、完全停稳的 done 和两类输出 | 只记住字段名 | 把 job 当普通 Promise |
| 能读出 A 的状态证据 | `running → stopping → killed`，且第二次 read 为空 | 结果通过但解释不了 stopping | demo 或断言失败 |
| 能读出 B 的清理证据 | 收到 `owner disposed`，dispose 后列表为空 | 只看到 cancel，未确认 await/remove | owner dispose 后仍有记录或资源 |
| 能制造并定位失败 | 至少完成 controller、isolation、wait abort 或 cancel throw 之一 | 看见错误但不能指出不变式 | 未运行负例 |
| 全章检查 | demo、章节测试与课程检查全部通过 | 局部检查通过 | 核心测试失败 |

只有获得实际命令输出并能解释一次负例，个人学习状态才能记为 `Pass`。阅读 README 本身不是掌握证据。

## 教学简化与生产边界

本章真实使用：

- 已发布的 `AgentRegistry` 与 exact live owner 校验；
- 已发布的 `LocalJobRegistry`、id、状态、访问控制、等待与 teardown；
- Cordis Plugin、effect 和 Fiber dispose；
- 完整的 `JobStart` / `JobHooks` producer contract。

本章教学 fixture：

- `DeterministicJobProducer` 由测试显式 `push/complete`，不会启动真实外部工作；
- lifecycle-only Agent 的消息方法是 no-op，不执行 LLM request；
- 1ms wait 只验证真实 timeout 语义，producer 自身完全不依赖时间；
- controller 是 host-side 实验控制面，不向模型注册工具。

生产中需要额外处理：

- Bash/subagent producer 对真实进程、AbortSignal、spill 和资源释放的适配；
- `dsh-tool-jobs` 的模型 schema、完成通知、输出上限与 wake budget；
- AgentLoop 对 `followup/inject` 的领取、模型轮次和 durable transcript；
- producer `cancel()` 返回却永远不结算 `done` 的缺陷会卡住 teardown；Registry 无法把它与缓慢但有效的停止区分；
- teardown 期间若 `cancel()` 抛错，Registry 会把记录 force-fail 以避免自身死锁，但底层工作可能成为 orphan work；生产 producer 必须让取消可重入、可观察并最终结算；
- `LocalJobRegistry` 随进程退出丢失。跨重启 job 需要重新设计身份、恢复和远程执行语义，不能把 JSONL session persistence 直接套上去；
- 多个 UI/模型观察者不能共享当前的消费式输出游标。

AgentLoop 的边界尤其重要：本章已经真实验证 job Service 状态机，不需要 AgentLoop。只有当目标变成“让真实 Agent 创建 job、由模型调用 `job_output/job_list/job_kill`、接收完成通知并把结果写进 transcript”时，AgentLoop 才成为必要依赖。

## 上游观察卡

完成实验后复制并填写：

```text
观察对象：@deepseek-ai/dsh-jobs / @deepseek-ai/dsh-jobs-local / symbol
固定版本：0.1.1-rc.2 / b150a551b8d465e31e418e1b2eaf5e79bbb7d28e
预期行为：
实际行为：
复现命令：
证据：demo / test / error output
分类：学习误解 / 文档歧义 / producer contract 问题 / 可复现缺陷 / 插件机会
下一步：留在课程 / 补指南 / 写 producer 插件 / 发 GitHub Discussion
```

优先记录能被固定版本自动复现的事实。不要把 lifecycle-only fixture 的限制误报成上游 AgentLoop 缺陷，也不要为了贡献数量制造重复 Discussion。
