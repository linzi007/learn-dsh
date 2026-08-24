# 06：AgentLoop 双轨——真实 DeepSeek 与 Keyless 显微镜

> 一句话目标：先让官方 DeepSeek adapter 驱动真实 `AgentLoop` 与 `course_add` 完成一次在线闭环，再用无网络的 `ScriptedLlmAdapter` 把同一条因果链拆开观察和故障注入。

- 上一章：[05 Tool contract](../s05_tool_contract/)
- API Key：默认真实实验需要；keyless 拆解与自动测试不需要
- 本章核心增量：从“单独调用工具”走到“Agent 在一个 Turn 内自主完成模型 → 工具 → 模型闭环”
- 下一章：[07 Permission](../s07_permission/)

## 问题

S05 已经证明 `course_add` 的参数校验、执行、canonical value 和 rendered content 都成立，但当时是课程代码直接调用：

```ts
ctx.tools.execute(...)
```

真实 Agent 不能只做这一步。模型先产出一个 `tool-call`，运行时执行工具并持久化结果，然后模型必须在下一次请求里读到该结果，才能给用户最终答案。

本章要观察的不是“42 算对了”这一件事，而是下面整条闭环是否真的发生：

```text
用户消息 → 第一次模型请求 → tool-call → 工具执行
        → tool/result → 第二次模型请求 → 最终文本 → idle
```

如果只跑课程脚本，你能证明 AgentLoop 的 plumbing，却不能证明真实模型会选工具；如果只连在线模型，API Key、网络、额度和随机性又会掩盖机制错误。因此本章采用两条轨道，而不是二选一：

```text
A 轨（默认学习入口）：官方 DeepSeek adapter → 证明真实模型会工作
B 轨（固定显微镜）  ：ScriptedLlmAdapter   → 精确解释为什么会工作
```

两轨只替换最外侧 `LlmAdapter`。Agent、AgentLoop、ToolRuntime、Session、Registry 与 S05 的工具定义完全相同。真实结果回答“它现在能否工作”，keyless 结果回答“控制流为什么如此”；CI 只运行 B 轨，不能冒充真实 provider 证据。

## 先认识六个基本概念

### 1. `Agent` 与 `AgentHandle`

`Agent` 是正在运行的主体，持有自己的 id、配置、Session、inbox、状态与作用域 Context。它提供 `followup()`、`whenIdle()` 等驱动和观察能力。

本章不直接 new 一个 Agent，而是通过 Registry 的公开 factory：

```ts
const handle = await ctx.agents.create({
  sessionId,
  agentOptions: { provider, model },
})
```

返回的 `AgentHandle` 包含：

- `handle.agent`：公开的活 Agent；
- `handle.dispose()`：只有持有者才拥有的 teardown capability。

`dispose()` 会停止并等待 loop 收敛，再从 Agent Registry 和 Session Store 移除这对共享 id 的对象。`ctx.agents.get(id)` 只能取得 Agent，不能凭空取得别人的销毁权限。

### 2. `Turn` 与 `Step`

这两个词不能混用：

- `Turn`：一次面向用户目标的完整处理边界，以 `turn/start` 开始、`turn/end` 结束。
- `Step`：Turn 内的一次模型处理与其产生的工具执行，以 `step/start` / `step/end` 包围。在本章无重试的正常路径上，一个 Step 恰好发起一次 provider 请求；若 provider 请求失败并被恢复 policy 判定为 retry，同一个 Step 内也可能再次请求，不能把“Step”绝对等同于“一次底层网络请求”。

本章只有一个 Turn，却有两个 Step：

```text
Turn 1
  Step 1：模型请求 course_add，运行时执行工具
  Step 2：模型读到工具结果，输出最终文本
```

工具调用不会天然开启新的 Turn。工具要求模型继续思考时，是同一个 Turn 进入下一个 Step。

### 3. `LlmAdapter`、`GenerateOptions` 与 `StreamChunk`

`LlmAdapter` 是 Harness 与模型提供方之间的协议边界。AgentLoop 不关心背后是 DeepSeek、其他在线服务，还是课程脚本；它只调用：

```ts
adapter.stream(options)
```

其中：

- `GenerateOptions` 是完整请求，包含 provider、model、历史 messages、system、tools 与取消 signal；
- AgentLoop 组装的请求会 deep-freeze，adapter 只能读取，不能就地修改；
- `StreamChunk` 是响应流协议，例如 `block-start`、`text-delta`、`tool-call-delta`、`block-end`、`usage`、`finish`。

[`src/scripted-llm.ts`](src/scripted-llm.ts) 的 `ScriptedLlmAdapter` 是本章唯一明确的 fake。它不访问网络，但严格发送真实公开协议的 chunk；真实 `AgentLoop` 仍用 `BlockAssembler` 组装 assistant message。

### 4. `followup()` 与 `whenIdle()`

```ts
handle.agent.followup(message)
await handle.agent.whenIdle()
```

`followup()` 把一条普通消息放入 `next-turn` FIFO，并唤醒 driver。它返回 `void`，没有“一条消息对应一个最终回复”的 Promise。

`whenIdle()` 等待整个 Agent 活动完全停稳，包括当前 driver 退役前接续的工作。它也不是某条消息的独立回执；在有多个并发生产者的系统里，调用方不能把一次 `whenIdle()` 随意归因给某一条输入。本章只有一个受控生产者，所以可以把完整 idle 区间作为实验边界。

### 5. tool round-trip 与 append-only `Session`

第一次 assistant message 内含 `tool-call` block，随后 AgentLoop 依次追加：

```text
tool/call   { callId, name, arguments }
tool/result { message.source.callId, content, isError }
```

两者用同一个 `CallId` 配对。`tool/result.sourceEventSeqs` 还会引用对应 `tool/call` 的 seq，留下“这个结果来自哪一次已记录调用”的证据。

第二次 `GenerateOptions.messages` 不是课程手工拼出来的；AgentLoop 从 append-only Session 的 surface 重新派生历史，因此会自然包含 user message、assistant tool call 和工具结果。最终 assistant message 与 `turn/end` 也继续追加，旧事件没有被覆盖。

### 6. provider、model 与 credential

这三个配置分别回答不同问题：

- `provider: deepseek-official`：选择 `@deepseek-ai/dsh-llm-deepseek` 注册的固定路由；
- `model: deepseek-v4-flash`：传给该 provider 的模型 id，AgentOptions 必须明确给出；
- `DEEPSEEK_API_KEY`：adapter 在真正发请求时读取的凭据，Plugin 挂载时不会读取或复制它。

根目录 `.env.example` 还使用 `DEEPSEEK_MODEL`，但这是 **Learn DSH 自定义的课程变量**，不是上游 Harness 或 DeepSeek API 的标准变量。课程读取它后再填入 `AgentOptions.model`；未设置时固定回退到 `deepseek-v4-flash`。

不要把 Key 写进 TypeScript、`cordis.yml`、测试快照或命令历史。官方 Plugin 的 `apiKeyEnv` 配置也是“环境变量的名字”，不是 Key 字面值。

## 你会交付什么

本章交付三组可运行证据：

1. 真实在线闭环：DeepSeek 必须实际调用 `course_add(20, 22)`，Session 中出现配对的 `tool/call` / `tool/result`，最终回答含 `42`，并记录真实 token usage。
2. Keyless 正向闭环：固定两次模型响应，把“一个 Turn、两个 Step”的完整事件顺序变成可重复断言。
3. Keyless 负向边界：持续请求工具的 fake LLM 被课程自定义 `maxStepsPerTurn` policy 阻断，不会无限运行。

文件分工：

- [`src/scripted-llm.ts`](src/scripted-llm.ts)：可跨章复用的 LLM fake、响应 builders 与 provider/model 常量。
- [`src/agent-harness.ts`](src/agent-harness.ts)：公开 testkit 依赖组合、Agent 创建 helper 与步骤预算 policy。
- [`src/loop-lab.ts`](src/loop-lab.ts)：正向和负向场景、事件探针与清理。
- [`src/real-config.ts`](src/real-config.ts)：只校验 Key 是否存在并解析课程模型变量，从不返回 Key。
- [`src/real-agent-harness.ts`](src/real-agent-harness.ts)：官方 DeepSeek adapter、成本上限与真实 Agent 组合。
- [`src/real-deepseek-lab.ts`](src/real-deepseek-lab.ts)：真实 Session 证据、usage 汇总、超时取消与清理。
- [`src/real-demo.ts`](src/real-demo.ts)：默认在线入口，使用断言拒绝“模型口头声称调用过工具”。
- [`src/demo.ts`](src/demo.ts)：keyless 轨的两组 PASS 输出。
- [`tests/agent-loop.test.ts`](tests/agent-loop.test.ts)：请求、CallId、来源 seq、轨迹、状态与 dispose 契约。
- [`tests/real-config.test.ts`](tests/real-config.test.ts)：不联网验证缺 Key、默认模型与 Secret 不出现在解析结果中。

上一章只有一份正式工具定义；本章直接导入 [`courseAddToolPlugin`](../s05_tool_contract/src/course-add-tool.ts)，没有复制 schema 或 execute body。

## 机制图

两条轨道共享中间全部节点：

```text
                         ┌─ A：官方 DeepSeek adapter（网络、计费、随机）
用户 → 真实 AgentLoop ───┤
                         └─ B：ScriptedLlmAdapter（本地、固定、可故障注入）
          │
          └─ tool/call → 真实 ToolRuntime → course_add → tool/result
                                │
                                └─ append-only Session → 下一 Step → 最终文本
```

下面把 B 轨展开；A 轨产生同类 Session 事件，但 chunk 内容、token 数和最终措辞不固定：

```text
调用方
  │ followup("请计算 20 + 22")
  v
真实 Agent + AgentLoop                 append-only Session
  │                                       │
  ├─ Turn 1 / Step 1 ───────────────────> turn/start, step/start, user/message
  │                                       │
  ├─ GenerateOptions #1                   │
  │    tools: [course_add]                 │
  v                                       │
fake ScriptedLlmAdapter                   │
  │ tool-call(id=call-1, 20, 22)           │
  v                                       v
真实 AgentLoop assembler ───────────────> assistant/message, tool/call
  │
  v
真实 ToolRuntime ──> S05 course_add ────> tool/result "20 + 22 = 42"
  │                                       │
  ├─ Turn 1 / Step 2                      │ deriveMessages()
  ├─ GenerateOptions #2 <─────────────────┘
  │    messages 中已有真实 tool-result
  v
fake ScriptedLlmAdapter
  │ 读取结果文本后生成最终回答
  v
真实 AgentLoop ─────────────────────────> assistant/message, step/end,
                                          turn/end(completed)
  │
  v
idle ── handle.dispose() ──> Agent / Session 均从 Registry 移除
```

“fake”只出现在 B 轨的模型边界。A 轨改用上游官方 `@deepseek-ai/dsh-llm-deepseek`；图中的 AgentLoop、ToolRuntime、Session、Registry 和 `course_add` 在两轨都来自真实公开包或 S05 已验收定义。

## 本章边界

本章只解决一个无副作用工具的“真实体验 + 确定性拆解”闭环。

有意不进入：

- 凭据托管服务、自动重试和 provider wire mapping 的逐字段实现；
- permission、approval、sandbox 与危险工具确认；
- 多个并行 tool calls 及调度上限；
- steer / inject 的竞态和多生产者消息归因；
- 持久化 backend、崩溃恢复、checkpoint 与 compaction；
- 长对话 token 成本估算和真实模型质量评测。

permission 与 approval 从下一章开始。本章的 `course_add` 是无副作用整数运算，不提前隐藏安全插件或加载顺序。A 轨关闭 thinking、把每次输出限制为 512 token、每 Turn 最多 3 个 Step，并且没有加载自动 retry Plugin；这些是学习 canary 的费用边界，不是“免费”承诺。

## 手把手实验

### A 轨：先跑真实 DeepSeek

#### 第 0 步：准备本机配置

在仓库根目录执行：

```bash
cp -n .env.example .env
chmod 600 .env
```

`cp -n` 不会覆盖已有 `.env`；如果文件已经存在，先确认其中是否已有你要保留的本机配置。

打开 `.env`，只填写你自己的 Key；模型先保留课程默认值：

```dotenv
DEEPSEEK_API_KEY=在本机填写，不要粘贴到文档、Issue 或提交中
DEEPSEEK_MODEL=deepseek-v4-flash
DSH_HOME=.dsh
```

Key 在 [DeepSeek 开放平台](https://platform.deepseek.com/api_keys)管理；运行前先查看[官方定价页](https://api-docs.deepseek.com/quick_start/pricing/)，不要把课程的 token / Step 上限误解成免费额度。

`.gitignore` 已忽略 `.env` 与 `.dsh/`，但忽略规则不是泄密补救措施。`git status --short --ignored` 只能确认这两个路径是否被忽略，**不能**扫描其他文件内容；提交前还要人工复核 staged diff，并使用可信的 Secret scanner。若 Key 曾进入 Git，即使随后删除当前文件，也应立即轮换凭据并清理历史。

无论使用官方默认端点还是自定义 `DEEPSEEK_BASE_URL`，接收方都会收到 Bearer Key、Prompt、工具 schema / 结果，以及 Harness 发送的稳定 anonymous user id 和当前 session id；自定义变量只是改变接收方，因此只配置你明确信任的网关。

本章唯一工具 `course_add` 不能读取文件或执行命令，所以仓库根 `.env` 适合作为入门配置。未来给 Agent 增加 filesystem / shell 工具后，`.gitignore` 与 `chmod 600` 都不能阻止模型借工具读取工作区内的 `.env`；生产环境应改用 credentials service、进程启动器或平台 Secret 注入，并让 Secret 位于 Agent 可访问工作区之外。

#### 第 1 步：先预测真实证据

运行前写下答案：

1. 模型最终说“42”，能否单独证明它调用了工具？
2. 哪两类 Session 事件才是实际执行的证据？
3. 正常闭环预期至少产生几次模型请求？
4. `DEEPSEEK_MODEL` 是上游变量，还是课程把环境值映射进 AgentOptions 的约定？

#### 第 2 步：核对真实组合，而不是手写 HTTP

打开 [`src/real-agent-harness.ts`](src/real-agent-harness.ts)：

```text
mountAgentLoopTestDependencies(ctx)
mount 官方 LlmDeepSeek Plugin
mount S05 courseAddToolPlugin
mount AgentLoop({ agents: [] })
install maxStepsPerTurn = 3
ctx.agents.create({ provider: deepseek-official, model })
```

课程没有自己拼 `/chat/completions` 请求，也没有把 Key 取出后放进 config。官方 adapter 在每次真实请求时从 `DEEPSEEK_API_KEY` 解析凭据；[`src/real-config.ts`](src/real-config.ts) 只做非空检查并返回 provider/model。

#### 第 3 步：运行默认真实入口

```bash
corepack pnpm demo:s06
```

这个命令会访问网络并产生少量模型费用。它不是“看最终答案包含 42 就通过”，而是同时断言：

- `request/context` 中的 provider/model 与本机配置一致；
- 至少出现一次真实 `tool/call(name=course_add)`；
- 同一 `CallId` 能找到成功的 `tool/result`，rendered text 是 `20 + 22 = 42`；
- 最终文本包含工具结果，`turn/end` 为 `completed`，Agent 回到 `idle`；
- 每次 assistant response 都留下 usage，清理后 Registry 中不再有 Agent / Session。

真实模型的措辞、CallId 和 token 数每次可能不同，不要把它们写成逐字快照。优先按稳定 code 排障：

| 结果 / code | 先检查什么 |
| --- | --- |
| `MISSING_CREDENTIAL` | `.env` 是否存在、`DEEPSEEK_API_KEY` 是否为非空值 |
| `AUTH` | Key 是否有效、是否属于当前端点；不要打印 Key 调试 |
| `QUOTA` | 余额或额度，查看官方控制台与定价 |
| `RATE_LIMIT` | 请求频率；本章不自动 retry，避免隐藏重复计费 |
| `TRANSPORT` / `TIMEOUT` | DNS、代理、TLS、可信网关与网络可达性 |
| 请求成功但没有 `tool/call` | 模型行为、模型 id 或提示约束，不是凭据错误 |

CLI 只回显稳定 code，不打印自定义网关提供的原始错误正文，避免不受信响应把敏感内容反射到终端。需要更多细节时，先确认端点可信，再在受控环境中检查 provider 日志。

### B 轨：再用 Keyless 显微镜解释因果链

#### 第 0 步：先预测

运行前写下答案：

1. 一次工具调用会产生几个 Turn、几个 Step？
2. 第二次模型请求应该只看到工具文本，还是看到带 `CallId` 的完整 `tool-result` block？
3. `followup()` 返回后，Agent 是否已经处理完成？
4. `handle.dispose()` 后，`ctx.agents.get(id)` 和 `ctx.sessions.get(id)` 应返回什么？

#### 第 1 步：只找唯一的 fake

打开 [`src/scripted-llm.ts`](src/scripted-llm.ts)，先找到：

```ts
export class ScriptedLlmAdapter extends LlmAdapter
```

它记录收到的 `GenerateOptions`，并按脚本 yield `StreamChunk`。逐个核对工具响应的顺序：

```text
block-start → tool-call-delta → block-end → usage → finish(tool-calls)
```

文本响应则是：

```text
block-start → text-delta → block-end → usage → finish(stop)
```

每次输出前都检查 `options.signal`；有限脚本默认耗尽时会抛稳定的 `SCRIPT_EXHAUSTED`，不会用空流掩盖课程错误。负向实验会显式启用 `repeatLast`，只为构造一个需要 policy 截断的重复步骤。

#### 第 2 步：核对 Keyless 组合顺序

打开 [`src/agent-harness.ts`](src/agent-harness.ts)。组合顺序是：

```text
mountAgentLoopTestDependencies(ctx)
  └─ LlmRuntime → SessionStore → SystemPrompt → ToolRuntime → AgentRegistry
register ScriptedLlmAdapter
mount S05 courseAddToolPlugin
mount AgentLoop({ agents: [] })
ctx.agents.create(...)
```

`@deepseek-ai/dsh-agent-loop-testkit` 是已发布的公开测试组合 helper，不是生产 bundle。它只按正确依赖顺序挂载前置 Service，不注册 adapter、不挂 AgentLoop，也不驱动消息。

Agent 的 `setup` 回调若使用，只能在发布前组合 scoped plugin、tool 或 listener；不能提前 `followup()` 驱动尚未完成发布的 Agent。本实验无需 setup。

#### 第 3 步：追踪第一次请求

打开 [`src/loop-lab.ts`](src/loop-lab.ts) 的 `createRoundTripAdapter()`。第一段 script 返回：

```ts
course_add({ left: 20, right: 22 })
```

运行时检查第一份 `GenerateOptions.tools`。其中应该出现 S05 的 `course_add` schema；若工具 Plugin 没有在 AgentLoop 前挂载，这里就不会凭空出现。

#### 第 4 步：确认第二次响应没有写死 42

继续读第二个 script step。它接收真实 request，并调用：

```ts
findToolResult(request, POSITIVE_CALL_ID)
```

最终文本来自 `tool-result.content` 中的 rendered text。把 S05 工具故意改坏会使本章失败，而不是 adapter 仍然“猜中”42；完成实验后要恢复上一章文件。

#### 第 5 步：运行 Keyless demo

```bash
corepack pnpm demo:s06:keyless
```

先看模型请求次数，再逐项读简化轨迹。简化轨迹有意折叠 `agent/inbox/spliced`、`request/header`、`request/context` 与逐 chunk 的 `assistant/chunk`；这些原始事件仍保留在 `result.events` 和真实 Session 中。

#### 第 6 步：运行自动测试

```bash
corepack pnpm test:s06
```

测试不仅看最终字符串，还验证：

- 两次请求以及第二次请求的真实工具结果；
- assistant block、`tool/call`、result message source 和 result block 的 `CallId` 一致；
- `tool/result.sourceEventSeqs` 精确引用 call event；
- Step 是 `1, 2`，`turn/end.reason.kind` 是 `completed`；
- `whenIdle()` 后状态是 `idle`；
- `AgentHandle.dispose()` 后两个 Registry 都查不到该 id。

#### 第 7 步：做自己的正向修改

只修改 [`src/loop-lab.ts`](src/loop-lab.ts) 中第一次工具调用，例如改成：

```ts
{ left: 35, right: 7 }
```

先不修改第二个 script step，运行 demo。若最终文本自然变成 `35 + 7 = 42`，说明第二步确实消费工具结果；若它仍写着旧算式，就说明你绕过了 round-trip。随后同步更新测试并复跑，最后决定保留修改还是恢复课程基线。

## 负向实验

### 为什么是 `maxStepsPerTurn`，不是“最大轮数”

一个模型可以在同一个 Turn 里不断请求工具：

```text
Step 1 tool-call → Step 2 tool-call → Step 3 tool-call → ...
```

所以这里限制的是“每个 Turn 最多进入多少个 Step”，命名为 `maxStepsPerTurn`。若叫最大轮数，会把 Turn 和 Step 的边界教反。

`0.1.1-rc.2` 的 AgentLoop 没有内置这项 turn/step budget。本章明确实现一条课程自定义 policy：

```ts
ctx.on('agent/pre-step', ({ step }, next) =>
  step > maxStepsPerTurn
    ? Promise.resolve({ kind: 'reject' })
    : next(),
)
```

[`runStepBudgetScenario()`](src/loop-lab.ts) 使用同一个 `ScriptedLlmAdapter` 的 `repeatLast` 模式，跨请求持续产出 `course_add`，并设定 `maxStepsPerTurn = 2`：

1. Step 1 和 Step 2 正常进入，各执行一次真实工具；
2. AgentLoop 提议 Step 3 时，`agent/pre-step` 返回 `{ kind: 'reject' }`；
3. 因为拒绝发生在进入边界前，所以没有第 3 个 `step/start`；
4. Turn 以 `blocked` 结束，driver 回到 `idle`，测试不会挂死。

亲手做一个安全的 off-by-one 故障注入：

1. 临时把 `step > maxStepsPerTurn` 改成 `step >= maxStepsPerTurn`。
2. 运行 `corepack pnpm exec vitest run s06_keyless_agent_loop/tests/agent-loop.test.ts`。
3. 此时 Step 2 会被过早拒绝，只产生 1 次模型请求和 1 对 `tool/call` / `tool/result`；测试中期待 2 次的断言应变红。
4. 恢复为 `>`，重新运行直到全绿。

第二个 `PASS` 表示负向探针成功捕获并截断边界，不表示工具自循环是正确业务行为。

## 预期观察

A 轨的关键输出形态如下；CallId、最终措辞和 token 数由真实模型决定：

```text
准备真实 DeepSeek 实验（会访问网络并产生少量模型费用）
  provider / model：deepseek-official / deepseek-v4-flash
  边界：thinking=off，maxTokens=512，maxStepsPerTurn=3

PASS 1/2：真实模型确实选择并执行了 course_add
  CallId：<每次不同>
  工具结果：计算结果：20 + 22 = 42
  最终回答：<包含 42 的真实回答>

PASS 2/2：真实调用留下 route、usage 与 teardown 证据
  模型请求 / input / cache-read / output tokens：<真实数值>
  turn/end → idle；dispose 后 Agent 与 Session 均已移除
  配置解析结果只含 provider/model；输出未打印 API Key
```

B 轨的关键输出形态如下，事件 seq 与 message id 会由运行时生成：

```text
PASS 1/2：真实 AgentLoop 完成两步 tool round-trip
  模型请求：2 次
  简化轨迹：turn/start → step/start → user/message → assistant/message → tool/call → tool/result → step/end → step/start → assistant/message → step/end → turn/end
  最终文本：我读取了真实工具结果：计算结果：20 + 22 = 42
  dispose：Agent 与 Session 均已从 Registry 移除

PASS 2/2：负向探针在第 3 个拟议 step 前截断工具自循环
  maxStepsPerTurn：2
  已执行模型请求 / 工具结果：2 / 2
  turn/end：blocked
  最终状态：idle
```

原始日志比简化轨迹更细，因为每个 `StreamChunk` 都会追加一条 `assistant/chunk`；`request/header` 记录可重建的请求配置，`request/context` 记录 route facts。这些不是噪音，只是本章先聚焦控制流而有意折叠。

## 对照真实源码

本章运行以下已发布版本：

- `@deepseek-ai/dsh-agent@0.1.1-rc.2`
- `@deepseek-ai/dsh-agent-loop@0.1.1-rc.2`
- `@deepseek-ai/dsh-agent-loop-testkit@0.1.1-rc.2`
- `@deepseek-ai/dsh-llm@0.1.1-rc.2`
- `@deepseek-ai/dsh-llm-deepseek@0.1.1-rc.2`
- `@deepseek-ai/dsh-session@0.1.1-rc.2`
- `@deepseek-ai/dsh-tools@0.1.1-rc.2`

固定对照 DeepSeek Harness commit `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`：

- [公开 AgentLoop testkit 组合 helper](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/test-support/agent-loop-testkit/src/index.ts)
- [`LlmAdapter` 与 `LlmRuntime`](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/llm/llm/src/index.ts)
- [官方 DeepSeek Plugin、provider route、credential 与 catalog 默认值](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/llm/llm-deepseek/src/index.ts)
- [官方 DeepSeek adapter 中文配置与错误语义](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/llm/llm-deepseek/README.zh.md)
- [`GenerateOptions` 与 `StreamChunk`](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/llm/llm/src/types.ts)
- [`AgentRegistry`、`AgentHandle` 与 factory API](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/core/agent/src/index.ts)
- [`Agent`、`followup`、`whenIdle` 与 pre-step event](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/core/agent/src/runtime-types.ts)
- [`AgentLoop` Plugin 与 Agent factory](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/core/agent-loop/src/index.ts)
- [Turn / Step driver 与请求重建](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/core/agent-loop/src/agent.ts)
- [`tool/call` / `tool/result` 执行与配对](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/core/agent-loop/src/tool-calls.ts)
- [AgentLoop 上游契约测试](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/core/agent-loop/tests/loop.spec.ts)
- [AgentLoop 中文说明](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/core/agent-loop/README.zh.md)

链接固定到 commit 和文件，不携带容易漂移的 `#Lxx` 行号。课程没有复制上游 driver，只在公开 adapter seam 提供最小可控输入。

## 验收

依次运行：

```bash
corepack pnpm demo:s06          # A 轨：联网、计费
corepack pnpm demo:s06:keyless  # B 轨：固定、离线
corepack pnpm test:s06          # B 轨 + 配置负例，不联网
corepack pnpm typecheck
```

通过条件：

- A、B 两个 demo 分别输出两项 PASS；
- A 轨 route/model 正确，真实 `course_add` 调用与结果用同一 CallId 配对，最终文本包含 `42`，usage 大于 0；
- 正向场景恰好两次模型请求、一次工具执行和两个 Step；
- 最终文本由第二次请求读到的真实 `tool-result` 生成；
- CallId 与 `sourceEventSeqs` 配对正确；
- 正向 `turn/end` 是 `completed`，负向是 `blocked`，两者最终都 `idle`；
- 负向场景没有第 3 个 `step/start`；
- dispose 后 Agent 与 Session 都从 Registry 消失；
- 配置缺 Key 时在网络请求前给出明确错误，解析结果和输出不包含 Key；
- 文档和源码没有真实 API Key、permission fake 或课程自制 AgentLoop。

其中“恰好两次请求”的固定断言只属于 B 轨。A 轨允许模型在 3 个 Step 的预算内产生不同轨迹，但必须实际执行目标工具并正常完成。

## 教学简化与生产边界

| 本章做法 | 为什么适合学习 | 生产环境还需要什么 |
| --- | --- | --- |
| 官方 DeepSeek adapter + 小额 canary | 证明 provider、模型选择和真实 tool-use 确实可用 | 凭据托管、预算告警、可信网关、限流、故障恢复与质量评测 |
| `ScriptedLlmAdapter` | 请求与响应完全确定，可精确观察控制流 | 与真实 provider e2e 并存，不能拿 fixture 通过冒充线上质量 |
| 进程内真实 Session | 能证明 append-only 轨迹和请求重建 | persistence、flush/checkpoint、恢复与日志保留策略 |
| 无副作用 `course_add` | 先隔离 AgentLoop 主干 | permission、approval、sandbox、幂等与审计；下一章开始 |
| 课程 `maxStepsPerTurn` listener | 最小方式暴露 step budget 边界 | 结合 token、成本、wall-clock、工具副作用和用户策略统一治理 |
| testkit 组合依赖 | 测试加载顺序透明、重复少 | 生产 launcher/Loader 自己拥有完整拓扑，不能把 testkit 当部署 bundle |

还要注意：`whenIdle()` 是 whole-agent quiescence，不是通用 request/response correlation API；本章的单生产者假设不能直接搬到并发服务中。

## 上游观察卡

读完固定源码后，用自己的话填写：

```md
- 我观察的文件：
- AgentRegistry.create 为什么返回 AgentHandle，而 get 只返回 Agent：
- 一个 tool-call 为什么会让同一 Turn 进入下一个 Step：
- 第二次 GenerateOptions.messages 从哪里重建：
- tool/result 如何关联 tool/call（CallId + seq）：
- pre-step reject 为什么不会产生 step/start：
- testkit 做了什么、明确没做什么：
- `deepseek-official`、`DEEPSEEK_MODEL` 与 `DEEPSEEK_API_KEY` 分别是谁定义的：
- 真实轨如何证明模型真的调用过工具：
- 真实轨与 Keyless 轨各自能证明什么、不能证明什么：
- 哪一处仍是课程 fake：
- 我能迁移到真实项目的模式：
- 我还解释不清的一个问题：
```

能独立解释“真实体验证明它能工作，Keyless 显微镜证明它为什么工作”，并说清“一个 Turn、两个 Step、两次模型请求、一次真实工具执行”的固定因果链，再进入 S07 Permission。
