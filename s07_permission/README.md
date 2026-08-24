# 07：Permission policy 与一次性 Approval

> 一句话目标：让真实 `AgentLoop` 在一个 open turn 内调用内存 `course_write`，由 `tools/pre-execute` 把 draft 委托放行、publish 路由到真实 `ApprovalService`、system 直接拒绝，并用 Session 审计证明授权只对一次调用有效。

- 上一章：[06 无 Key AgentLoop](../s06_keyless_agent_loop/)
- API Key：不需要
- 本章核心增量：从“模型请求工具就执行”走到“dispatch 前先经过可组合 policy，并对需要确认的单次调用留下成对审计”
- 下一章：[08 JSONL persistence](../s08_jsonl_persistence/)

## 问题

S06 已经跑通真实工具闭环，但当时模型请求 `course_add` 后，`ToolRuntime` 可以直接执行。换成有副作用的工具时，所有调用都直接放行会混淆三个不同问题：

1. 这类调用按部署规则能不能执行？
2. 规则无法直接决定时，谁来回答这一次确认？
3. 即使回答“允许”，工具 body 在什么隔离环境中运行？

本章只解决前两个问题：Permission policy 在 dispatch 前分类，Approval seam 对某一次 `ask` 给出结果。第三个问题属于 sandbox enforcement，不能因为出现了“审批”两个字就假装已经解决。

课程使用一个只写内存的 `course_write`，避免真实文件或系统副作用干扰控制流。它接受三个 target：

| target | `tools/pre-execute` 决定 | 是否询问 answerer | 工具 body |
| --- | --- | --- | --- |
| `draft` | 通过 `next()` 委托 | 否 | 没有后续 policy 拒绝时执行 |
| `publish` | `{ kind: 'ask' }` | 是 | 只有 `allowed-once` 才执行 |
| `system` | `{ kind: 'deny' }` | 否 | 不执行 |

主实验会连续请求两次 publish：第一次回答 `allowed-once`，第二次必须重新询问，并可以回答 `rejected`。如果第二次不再询问，本章就把“一次性授权”错误实现成了“记住授权”。

## 先认识八个基本概念

### 1. Permission policy 是 dispatch 前的分类规则

本章的 policy 监听真实 `tools/pre-execute`：

```ts
ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
  // inspect exec.name / exec.arguments
})
```

此时参数 schema 已经验证完成，工具 body 尚未运行。policy 可以读取工具名、参数、`CallId`、调用 Agent 与取消 signal，然后返回 `PreToolDecision`。

它不是一个新的 ToolRuntime，也不改写参数；参数已经进入调用与审计边界，pre-execute 只决定下一阶段是否可以发生。

### 2. `PreToolDecision`：`allow`、`ask`、`deny`

三种决定的含义是：

- `allow`：允许进入后续 guard 与 dispatch；
- `ask`：通过 Approval seam 询问这一次调用，只有 grant 才转为 allow；
- `deny`：不调用工具 body，生成一个模型可见的错误 `tool/result`。

本章 policy 对 publish 返回 `ask`，对 system 返回带稳定 reason 的 `deny`。错误结果仍由真实 AgentLoop 写入 append-only Session，模型可以在下一个 Step 看见拒绝，而不是遇到一个消失的调用。

### 3. 为什么安全路径必须调用 `next()`

`tools/pre-execute` 是 waterfall。一个 listener 不负责当前调用时，或认为当前调用在自己的规则下安全时，应调用：

```ts
return next()
```

这表示“我不否决，把决定交给后续 policy”。如果 draft 分支直接返回 `{ kind: 'allow' }`，waterfall 会在这里结束，后挂载的组织级 policy、Agent scoped policy 或其他收紧规则将失去否决机会。

因此 [`src/permission-policy.ts`](src/permission-policy.ts) 的 draft 分支记录 `allow-via-next`，但真正代码是 `return next()`。在可组合安全规则里，“我允许”和“我不反对”不是一回事。

### 4. `ApprovalService` 是一次问题的路由与审计 seam

`ApprovalService` 暴露为 `ctx.approval`。ToolRuntime 收到 `ask` 后会调用：

```ts
ctx.approval.request({ agent, toolName, callId, reason, signal })
```

服务自身不弹对话框，也不读取终端输入。真正回答问题的是 `approval/request` waterfall 上的 answerer，例如 UI、ACP bridge，或本章的确定性脚本。

answerer 返回结果表示认领这个问题；不属于自己的请求必须 `next()`。本章先创建 Agent，再把 answerer 注册到：

```ts
handle.agent.ctx.on('approval/request', ...)
```

这样它只会收到该 Agent 的 scoped 请求。把 answerer 随手注册在 root `ctx.on(...)` 会听到所有可见 Agent；多 Agent 部署若没有显式路由，很容易替不属于自己的会话作答。

### 5. `allowed-once` 是唯一 grant

`ApprovalOutcome` 是闭合集合：

- `allowed-once`：只允许当前 request 对应的这一次调用；
- `rejected`：answerer 明确拒绝；
- `cancelled`：请求在等待中被撤回；
- `unavailable`：没有 answerer、answerer 失败或返回非法值。

后三种都不能 dispatch。这里没有 `allow-always`，也没有“记住此工具”的授权存储。每次 publish 都产生新的 Approval request id；第一次 `allowed-once` 不改变下一次 publish 的 policy。

### 6. `approval/asked` 与 `approval/decided` 是成对审计

Approval request 必须发生在 open turn 内。服务先追加：

```text
approval/asked { id, toolName, callId, reason }
```

结果确定后再追加：

```text
approval/decided { id, outcome }
```

两者以 Approval request id 配对，`approval/asked.callId` 再关联原 `tool/call`。本章对每个 publish 验证完整顺序：

```text
tool/call → approval/asked → approval/decided → tool/result
```

审计事件是 log-only，不会作为额外对话文本重复喂给模型。模型看到的是最终成功或错误的 `tool/result`。

### 7. fail closed 与 `ApprovalPolicy`

`ApprovalPolicy` 有两个值：

- `ask`：把问题交给 answerer；没有可用 answerer 时得到 `unavailable`；
- `never`：在 answerer waterfall 之前直接得到 `rejected`，适合无人值守或明确禁止询问的环境。

两者都会写 asked/decided 审计对。区别是 `ask` 可能咨询 answerer，`never` 保证 answerer 完全不被调用。

“缺少 answerer”不能默认为允许，否则删除一个 UI Plugin 就会扩大权限。真实 `ApprovalService` 选择 fail closed；本章 demo 不交互，也不会因没人回答而挂起。

### 8. Approval 不等于 sandbox enforcement

本章必须保持这条边界：**Approval 不等于 sandbox enforcement**。

- Permission policy：决定是否进入工具 body；
- Approval：为某一次不确定决定取得 answer，并记录 outcome；
- sandbox enforcement：在工具真的运行时限制它能访问的文件、进程、网络、系统调用和凭据。

本章的 `course_write` 只修改 `MemoryCourseWorkspace`。即使 publish 获得 `allowed-once`，也只能证明 ToolRuntime dispatch 了 body；它没有证明操作系统隔离、路径约束或权限降级。真实 filesystem sandbox 必须由独立、可验证的执行层提供。

## 你会交付什么

本章交付三个不交互、不会挂起的真实 AgentLoop 实验：

1. policy matrix：draft 执行、第一次 publish 一次性允许、第二次 publish 重新询问后拒绝、system 直接拒绝；
2. no-answerer：`ask` 找不到 answerer，得到 `unavailable` 并 fail closed；
3. policy never：即使已经注册会返回 `allowed-once` 的 scoped answerer，也在调用它之前得到 `rejected`。

文件分工：

- [`src/course-write-tool.ts`](src/course-write-tool.ts)：内存工作区、真实 `defineTool` schema 与 Tool Plugin；
- [`src/permission-policy.ts`](src/permission-policy.ts)：draft / publish / system 的 `tools/pre-execute` waterfall policy；
- [`src/permission-lab.ts`](src/permission-lab.ts)：真实组合、S06 adapter 脚本、scoped answerer、审计配对和三个场景；
- [`src/demo.ts`](src/demo.ts)：带 `node:assert/strict` 的三项 PASS；
- [`tests/permission.test.ts`](tests/permission.test.ts)：dispatch、一次性授权、审计顺序、open turn 与两条 fail-closed 路径；
- [`tests/chapter-contract.test.ts`](tests/chapter-contract.test.ts)：教学结构、真实 API、边界声明与固定上游版本。

## 机制图

```text
真实 AgentLoop / open Turn
  │
  ├─ tool/call(course_write, target=draft)
  │      └─ tools/pre-execute → draft → next() → default allow
  │                                      └─ body 写入 draft#1
  │
  ├─ tool/call(course_write, target=publish #1)
  │      └─ tools/pre-execute → ask
  │             └─ ApprovalService
  │                  ├─ approval/asked(id=A, callId=publish-1)
  │                  ├─ agent-scoped answerer → allowed-once
  │                  └─ approval/decided(id=A, allowed-once)
  │                                      └─ body 写入 publish#2
  │
  ├─ tool/call(course_write, target=publish #2)
  │      └─ tools/pre-execute → ask（不会复用 A）
  │             └─ asked(id=B) → scoped answerer rejected → decided(id=B)
  │                                      └─ 不 dispatch，写错误 tool/result
  │
  └─ tool/call(course_write, target=system)
         └─ tools/pre-execute → deny
                                        └─ 不询问、不 dispatch、写错误 tool/result
```

每次 `tool/call` 最终都有一个 `tool/result`，因此真实 AgentLoop 能进入下一 Step，并最终写入 `turn/end { completed }` 回到 `idle`。

## 本章边界

本章只学习 ToolRuntime dispatch 前的 Permission policy 与一次性 Approval。

有意不进入：

- filesystem、process、network 或 syscall sandbox enforcement；
- 真实磁盘写入、命令执行和危险操作；
- `allow-always`、授权缓存、撤销、角色权限和组织策略存储；
- 交互式终端 prompt、Web UI、ACP transport 与远程 answerer；
- 多 Agent answerer ownership 的完整部署拓扑；
- 持久化恢复后 approval policy replay；
- monotonic guards、post-execute policy 与并行 tool-call 调度。

`MemoryCourseWorkspace` 是课程状态容器，不是安全容器。后续加入真实文件工具时，必须重新评估工具实现和 sandbox，而不是照搬本章的“内存写入成功”。

## 手把手实验

### 第 0 步：先预测

运行前写下答案：

1. draft 安全时，policy 应返回 `{ kind: 'allow' }`，还是调用 `next()`？
2. 第一次 publish 获得 `allowed-once` 后，第二次 publish 会不会再次产生 asked/decided？
3. system 被 policy deny 后，answerer 和工具 body 哪一个会运行？
4. `ApprovalService({ policy: 'ask' })` 没有 answerer 时应该允许、挂起，还是 fail closed？
5. Approval 允许了一次调用，是否意味着该 body 已在 OS sandbox 中运行？

### 第 1 步：确认工具真的只有内存副作用

打开 [`src/course-write-tool.ts`](src/course-write-tool.ts)。`MemoryCourseWorkspace.write()` 只把 `{ revision, target, content }` 追加到数组。

`course_write` 仍是通过真实 `defineTool()` 建立的 Tool Definition：参数必须包含枚举 target 与字符串 content，成功值也经过 output schema 和 renderer。Permission 不替代 S05 已学习的参数/输出 contract；无效参数会在 pre-execute 前失败。

### 第 2 步：逐分支阅读 policy

打开 [`src/permission-policy.ts`](src/permission-policy.ts)，只看 `switch (target)`：

```text
draft   → return next()
publish → return { kind: 'ask', reason }
system  → return { kind: 'deny', reason }
```

注意 `allow-via-next` 只是观察记录的名字，不是返回给 ToolRuntime 的第四种决定。真实返回仍是下游 waterfall 的结果。

### 第 3 步：核对显式组合顺序

打开 [`src/permission-lab.ts`](src/permission-lab.ts) 的 `mountPermissionHarness()`：

```text
mountAgentLoopTestDependencies(ctx)
  └─ LlmRuntime → SessionStore → SystemPrompt → ToolRuntime → AgentRegistry
register S06 ScriptedLlmAdapter
mount ApprovalService(policy)
mount course_write Tool Plugin
install tools/pre-execute policy
mount AgentLoop({ agents: [] })
```

这里没有调用 S06 的大组合 helper，因为本章必须把 Approval 与 policy 的位置明确展开。复用的只有 [`ScriptedLlmAdapter`](../s06_keyless_agent_loop/src/scripted-llm.ts)、response builders、provider/model 常量和 Agent 创建 helper。

### 第 4 步：确认 answerer 属于哪个 Agent

`runPermissionScenario()` 先调用 `createScriptedAgent()`，再注册：

```ts
handle.agent.ctx.on('approval/request', ...)
```

回调只认领 `course_write`，其他工具调用 `next()`。两次受理结果按顺序是 `allowed-once`、`rejected`。

不要为了少写一行把它改成无条件 root listener。全局 listener 能看到多个 Agent 的请求，生产环境必须明确它是全局组织策略，还是只属于一个 UI/Agent owner。

### 第 5 步：追踪一个 open turn

主脚本依次返回四个 tool-call 和一个最终文本，因此同一个 Turn 有五个 Step。对两次 publish，`approvalAuditPairs()` 使用：

- `approval/asked.callId` 找到原 `tool/call`；
- asked/decided 共用的 Approval request id 配对决定；
- tool-result block 的 `toolCallId` 找到最终结果。

四个事件的 seq 必须严格递增，而且都位于 `turn/start` 与 `turn/end` 之间。ApprovalService 不接受 idle ask；本实验能完成 audit pair，本身就是 open-turn 组合证据。

### 第 6 步：运行 demo

```bash
corepack pnpm exec tsx s07_permission/src/demo.ts
```

输出中的随机 Approval request id 不直接打印；稳定证据是两条 CallId、outcome、审计事件顺序、实际内存写入和 answerer 调用次数。

### 第 7 步：运行自动测试

```bash
corepack pnpm exec vitest run s07_permission/tests
```

测试验证：

- 四次 policy 分类和工具 body 实际执行次数；
- 两次 publish 生成两个不同 Approval request id；
- 每一对审计都严格位于 call 和 result 之间；
- 五个 Step 最终 `completed → idle`；
- no-answerer 是 `unavailable`；
- never 是 `rejected`，且 scoped answerer 调用次数为零。

### 第 8 步：做自己的安全修改

把第一次 answer 改成 `rejected`，第二次改成 `allowed-once`，同步调整断言后运行 demo 和测试。预期内存写入应变为 draft 加第二次 publish；Approval request 仍然恰好两次，审计顺序不变。

这个修改能区分“哪一次被允许”和“工具名已经被永久允许”。完成后恢复课程基线，或保留修改并让测试准确描述新预期。

## 负向实验

### 1. 没有 answerer：`unavailable`

[`runNoAnswererScenario()`](src/permission-lab.ts) 挂载真实 `ApprovalService({ policy: 'ask' })`，但不注册任何 `approval/request` listener。

publish 仍会写入 asked/decided，outcome 是 `unavailable`；ToolRuntime 将它转换为错误结果：

```text
Error: tool "course_write" requires approval, but no approval channel is available
```

工具 body 不执行，内存写入数为零，Turn 仍能继续到最终文本并回到 idle。缺失通道是立即 fail closed，不是等待一个永远不会出现的终端输入。

### 2. policy never：answerer 不会被调用

[`runNeverPolicyScenario()`](src/permission-lab.ts) 挂载：

```ts
ApprovalService({ policy: 'never' })
```

同时故意在 `handle.agent.ctx` 注册一个会返回 `allowed-once` 的 answerer。结果仍是：

```text
answerer calls = 0
approval outcome = rejected
workspace writes = 0
```

这证明 never 是 ApprovalService 自己在 waterfall 之前执行的确定性策略，不依赖 listener 注册顺序。

### 3. 手动制造错误的“抢占式 allow”

临时把 draft 分支的 `return next()` 改成：

```ts
return { kind: 'allow' }
```

然后在它后面注册一个会拒绝 draft 的 `tools/pre-execute` listener。后挂 listener 将不再被调用，说明前一个 listener 抢占了 waterfall。恢复 `next()` 后，后续收紧规则才有机会生效。

这不是说 draft 当前业务上危险，而是证明可组合 policy 中的安全分支不能替其他规则做最终决定。

## 预期观察

关键输出如下：

```text
PASS 1/3：draft / publish / system policy 经过真实 AgentLoop
  policy：draft:allow-via-next → publish:ask → publish:ask → system:deny
  实际写入：draft#1, publish#2
  s07-publish-allowed：tool/call → approval/asked → approval/decided → tool/result = allowed-once
  s07-publish-rejected：tool/call → approval/asked → approval/decided → tool/result = rejected
  allowed-once 后第二次 publish 仍重新 ask

PASS 2/3：ask 没有 answerer 时 unavailable，立即 fail closed
  audit outcome：unavailable
  工具结果：Error: tool "course_write" requires approval, but no approval channel is available

PASS 3/3：never policy 在 answerer 之前确定性拒绝
  answerer 调用次数：0
  audit outcome：rejected
  注意：Approval 控制 dispatch，不提供 filesystem / process sandbox
```

第二、第三项 PASS 表示 fail-closed 探针捕获了预期拒绝，不表示工具执行成功。

## 对照真实源码

本章运行以下已发布版本：

- `@deepseek-ai/dsh-agent-loop@0.1.1-rc.2`
- `@deepseek-ai/dsh-agent-loop-testkit@0.1.1-rc.2`
- `@deepseek-ai/dsh-llm@0.1.1-rc.2`
- `@deepseek-ai/dsh-session@0.1.1-rc.2`
- `@deepseek-ai/dsh-tools@0.1.1-rc.2`
- `@deepseek-ai/dsh-user-approval@0.1.1-rc.2`

固定对照 DeepSeek Harness commit `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`：

- [`PreToolDecision`、`tools/pre-execute` 与 ask 路由](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/core/tools/src/index.ts)
- [`ApprovalService`、policy、open-turn 审计与 fail-closed](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/interaction/user-approval/src/index.ts)
- [`ApprovalOutcome` 与 request id 类型](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/interaction/user-approval/src/types.ts)
- [AgentLoop 的真实 tool-call 调度](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/core/agent-loop/src/tool-calls.ts)
- [ToolRuntime ask / deny 上游测试](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/core/tools/tests/tools.spec.ts)
- [ApprovalService audit / policy 上游测试](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/interaction/user-approval/tests/approval.spec.ts)
- [User Approval 中文说明](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/interaction/user-approval/README.zh.md)

链接固定到 commit 与文件，不使用浮动分支或易漂移的 `#Lxx` 行号。课程没有复制 ApprovalService，只提供一个原创内存 Tool、一条 policy 和确定性 answerer。

## 验收

依次运行：

```bash
corepack pnpm exec tsx s07_permission/src/demo.ts
corepack pnpm exec vitest run s07_permission/tests
corepack pnpm exec tsc --noEmit
```

| 状态 | 判定 |
| --- | --- |
| Pass | 能解释 draft 为什么调用 `next()`；两次 publish 各有独立审计对；allowed-once 后仍重新 ask；system、unavailable、never 都不执行 body；能说明 scoped answerer 与 sandbox 边界 |
| Fix | 最终写入数正确，但把 direct allow 与委托混为一谈，或只检查 tool/result 而没有配对 asked/decided |
| Not yet | 缺 answerer 时默认允许、把 allowed-once 记成长期授权、从 idle 发起 Approval，或声称本章已经提供 filesystem sandbox |

完成后用自己的话回答：**为什么 draft 的安全路径仍要 `next()`？为什么一次 `allowed-once` 不改变下一次 publish？为什么 Approval 允许 dispatch 仍不能证明工具运行在 sandbox 中？**

## 教学简化与生产边界

| 本章做法 | 为什么适合学习 | 生产环境还需要什么 |
| --- | --- | --- |
| 内存 `course_write` | 能准确计数 body 是否 dispatch，没有真实破坏 | 文件/命令工具自己的 schema、幂等、路径约束、回滚和审计 |
| 三分支 policy | 一眼看清 `next` / ask / deny | 多条组织规则、Agent scoped 规则、monotonic guard 与配置来源 |
| agent-scoped scripted answerer | 无交互、确定性证明一次性 outcome | UI/ACP ownership、身份认证、超时、断线与并发 request correlation |
| Session audit pair | 能重建一次 ask 的因果链 | 持久化、查询、保留期、隐私脱敏和告警 |
| 无真实 sandbox | 避免把两个机制混教 | 独立的 filesystem/process/network enforcement 与逃逸测试 |

全局 `ctx.on('approval/request')` 不是天然错误，但它代表全局 answerer。只有当它确实拥有所有请求，并能按 Agent、租户和身份正确路由时才应这样部署；单 Agent UI 更适合注册到对应 `agent.ctx`。

## 上游观察卡

完成实验后填写：

```md
- 我观察的文件：
- draft 为什么是 next，而不是直接 allow：
- publish 的 CallId 如何贯穿 call / asked / result：
- asked 与 decided 用什么 id 配对：
- allowed-once 后什么状态被保留、什么没有：
- no-answerer 与 never 的区别：
- answerer 为什么注册在 agent.ctx：
- Approval 与 sandbox enforcement 的边界：
- 哪一处仍是课程 fake：
- 我能迁移到真实项目的模式：
- 我还解释不清的一个问题：
```

能独立解释“policy 分类 → scoped answerer → 一次性 outcome → 成对审计 → tool/result”，并明确它没有提供 OS sandbox，再进入持久化章节。
