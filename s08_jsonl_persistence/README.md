# 08：JSONL persistence——跨 Context 恢复同一条事件历史

> 一句话目标：让 Context A 的真实 Agent Turn、消息和 todo Projection 持久写入 plaintext JSONL，完全释放运行时后由 Context B `agents.resume()`，证明事件前缀、派生历史、Projection 与 Turn 编号都能连续恢复。

- 上一章：[07 Permission](../s07_permission/)
- API Key：不需要
- 本章核心增量：从“进程内 append-only Session”走到“磁盘上的 durable prefix、冷恢复与崩溃尾部修复”
- 下一章：[09 Background jobs](../s09_background_jobs/)

## 问题

S03 已证明 Session 事件只能追加，S04 已证明 Projection 能从事件 replay，S06 又让真实 AgentLoop 在一个进程里完成 Turn。可是只要进程退出，这些内存对象就都消失了。

生产系统还必须回答：

1. `whenIdle()` 后的事件是否真的落到磁盘？
2. 新 Context 如何恢复同一个 Session，而不是创建一段看似相同的新历史？
3. 恢复后，模型消息与 todo Projection 会不会产生偏差？
4. 崩溃留下半条 JSON 时，应该丢多少数据？
5. 已完整提交的中间行损坏时，能否 fail closed，既不发布 Agent，也不“顺手修坏”原文件？

本章使用真实 `JsonlSessionPersistence` 回答这些问题。LLM 仍复用 S06 的 `ScriptedLlmAdapter`，所以不需要 Key；它只让 Turn 的输出确定，不替代 Session、Persistence、Projection 或 AgentLoop。

## 先认识七个基本概念

### 1. `SessionPersistence` seam、backend 与 coordinator

三个角色不要混在一起：

- `SessionPersistence`：`ctx.sessionPersistence` 的抽象能力 seam，定义 `prepare()`、`load()`、`append()`、`readRaw()` 等公开约定。
- `JsonlSessionPersistence`：本章使用的具体 Provider，把 header 与事件保存为一个 session-owned JSONL 工件。
- `PersistenceCoordinator`：第一方后端共享的写入、flush、冷恢复、修复与生命周期协调器。

AgentLoop 不负责文件格式，Session 也不直接调用 `writeFile`。Session 同步接受事件，Persistence listener 复制事件并在自己的有序写入控制器中持久化。

### 2. 逻辑事件日志与物理 JSONL

本章配置：

```ts
{
  compression: 'none',
  packChunks: false,
}
```

因此文件是可直接阅读的 `session.jsonl`：

```text
第 1 行：SessionHeader，type = "session"，不是 SessionEvent
第 2 行：seq 0 的 SessionEvent
第 3 行：seq 1 的 SessionEvent
...
```

`packChunks:false` 让每个 `assistant/chunk` 也保持一事件一行，便于课程逐项比对。它没有丢 chunk，只关闭默认的多 chunk 合并行。`compression:'none'` 让 torn-tail 故障注入能精确制造“没有换行的半条 JSON”。

这两个开关只服务可观察性，不表示生产环境一定应该关闭 Zstandard 或 chunk packing。

### 3. `whenIdle()`、`flush()` 与 dispose

三个边界回答不同问题：

- `agent.whenIdle()`：Agent 的 driver 已完全停稳；它不是磁盘持久性证明。
- `ctx.sessions.flush(session)`：把该 Session 当前已接受的事件排空到 Persistence；返回 `true` 表示至少有 durability listener 参与。
- `AgentHandle.dispose()` / `ctx.fiber.dispose()`：停止接纳新工作，等待各自拥有的 drain，再按生命周期逆序释放。

所以正向路径必须是：

```text
followup → whenIdle → sessions.flush → handle.dispose → context.dispose
```

不能把“模型答完了”直接等同于“另一个进程已经能读到全部事件”。

### 4. `prepare()`、`agents.resume()` 与 unpublished publication

Context B 不调用 `agents.create()`，而是：

```ts
await ctx.agents.resume({ resumeSessionId, agentOptions })
```

AgentRegistry 把恢复委托给 AgentLoop factory；factory 先通过 `ctx.sessionPersistence.prepare(id)` 得到未发布的 Session。后端完成读取、校验和必要修复后，Agent 与 Session 才作为一笔 rollback-covered transaction 发布。

因此 committed corruption 若在 prepare 阶段失败：

```text
ctx.agents.get(id)   === undefined
ctx.sessions.get(id) === undefined
```

调用方不会短暂看到一个半恢复对象。

### 5. durable prefix、`firstLiveSeq` 与 `session/end-seed`

Context A flush 的事件是 Context B 的 durable prefix。若它有 N 个事件：

```text
Context B firstLiveSeq === N
Context B events[N]     === session/end-seed
```

`firstLiveSeq` 是本进程事实：小于它的事件来自构造 seed，本 lifecycle 没有发布过它们。`session/end-seed` 是这个边界在日志里的 marker；恢复构造器把它追加在 seed 后，后续 flush 再将其写入磁盘。

marker 不是用户消息，不进入 `deriveMessages()`，也不改变 todo Projection。恢复同一份历史不会凭空多出一轮模型对话。

### 6. `deriveMessages()` 与 Projection replay

Persistence 存的是 SessionEvent，不另外保存一套“消息表”或“todo 表”。Context B 恢复后：

- `session.deriveMessages()` 从 `user/message`、`assistant/message` 等 surface 事件重新派生模型历史；
- `SessionProjectionRegistry.snapshot(session)` 从 seed lazy fold S04 的 `todoProjection`；
- `todo/write` 虽不进入模型消息，却能恢复完全相同的 todo whole value。

本章同时断言事件、消息和 Projection，避免“文件能解析”被误当成“业务状态恢复正确”。

### 7. torn tail 与 committed corruption

两类故障的处置相反：

- torn tail：文件最后一条记录没有完整换行，说明写入可能只完成一半。只丢这个 fragment；此前完整事件全部保留。
- committed corruption：完整坏行位于后来已经闭合的 Turn 之前，说明损坏进入已提交区。必须拒绝，不能假装它只是尾部碎片。

若完整事件留下一个开放 Turn，冷恢复会在保留它们之后追加 synthetic closers：

```text
step/end
turn/end { reason: { kind: 'interrupted' } }
```

这里的 `interrupted` 表示 Persistence 在冷恢复时发现并关闭了崩溃遗留 Turn，不是 live Agent 收到用户 cancel 后产生的 `aborted`。

本章 fixture 没有悬空工具调用，所以不需要 synthetic `tool/result`；若存在未结算 tool call，共享修复逻辑会先追加对应失败结果，再关闭 Step 与 Turn。

## 你会交付什么

本章交付三个真实磁盘实验：

1. Context A 完成 Turn 1、追加 `todo/write`、flush 并完全 dispose；Context B resume 后验证 durable prefix、messages、Projection 和 seed marker，再继续 Turn 2。
2. 在开放 Turn 后追加半条 JSON；resume 只丢 fragment，保留完整事件并持久追加 `step/end` 与 interrupted `turn/end`。
3. 破坏完整 Turn 中的一条已提交事件；resume 拒绝，Agent/Session 不发布，文件字节保持不变。

文件分工：

- [`src/persistence-harness.ts`](src/persistence-harness.ts)：展开的 Service / Plugin 加载顺序与 create/resume helpers。
- [`src/jsonl-fixtures.ts`](src/jsonl-fixtures.ts)：精确临时目录、工件路径、unpacked JSONL reader 与安全清理。
- [`src/persistence-lab.ts`](src/persistence-lab.ts)：Context A → JSONL → Context B 的正向实验。
- [`src/recovery-lab.ts`](src/recovery-lab.ts)：torn tail 与 committed corruption 探针。
- [`src/demo.ts`](src/demo.ts)：使用 `node:assert/strict` 的三项 PASS。
- [`tests/persistence.test.ts`](tests/persistence.test.ts)：持久前缀、恢复语义、修复与拒绝契约。

课程直接复用：

- S04 的 [`todoProjection`](../s04_projection_replay/src/todo-domain.ts)；
- S06 的 [`ScriptedLlmAdapter` 与 response builder](../s06_keyless_agent_loop/src/scripted-llm.ts)。

## 机制图

```text
Context A
  mount testkit
    → register ScriptedLlmAdapter
    → SessionProjectionRegistry + todoProjection
    → AgentLoop
    → JsonlSessionPersistence
  │
  ├─ create(id)
  ├─ Turn 1: user/message → assistant/message → todo/write → turn/end
  ├─ whenIdle()
  └─ sessions.flush(session)
             │
             v
  <root>/_no-cwd/<id>/session.jsonl
    header
    seq 0..N-1 durable prefix
             │
  handle.dispose() → Context A dispose
             │
             v
Context B（全新的 Context 与 Service 实例）
  同样的显式组合
  │
  ├─ agents.resume(id)
  │    └─ persistence.prepare(id)
  │         ├─ read + validate durable prefix
  │         ├─ construct seeded Session
  │         └─ append session/end-seed at firstLiveSeq=N
  │
  ├─ deriveMessages() == Context A messages
  ├─ todoProjection replay == Context A todos
  ├─ followup → Turn 2
  └─ flush → seq 0..M 连续写回同一工件
```

这里没有把 `mountJsonlAgentRuntime()` 复用成后续所有章节的“神秘 bundle”。它专门把 S08 所需顺序写在一处，学习者可以直接看见 Projection 与 Persistence 分别在哪里加入。

## 本章边界

本章只验证单进程先完全释放 writer、再由新 Context 恢复的 plaintext JSONL 路径。

有意不进入：

- 两个进程同时写同一 Session；
- Zstandard frame、checksum 与压缩 torn-frame 恢复；
- `packChunks:true` 的物理行压缩率；
- SQLite 或远程对象存储 backend；
- retention、删除、归档、加密与磁盘配额；
- checkpointed Projection cache；
- Windows JSONL durability 与原子发布验证。

本章没有工具调用，也不重复 S07 的 permission/approval 实验。真实系统组合危险工具时，Persistence 不能替代权限检查。

## 手把手实验

### 第 0 步：先预测

运行前回答：

1. `whenIdle()` 是否足以证明 JSONL 已包含最后一条事件？
2. JSONL header 是否占用事件 seq 0？
3. Context B resume 后，`firstLiveSeq` 指向 durable prefix 的最后一项还是后一项？
4. `session/end-seed` 会不会进入 `deriveMessages()`？
5. 半条末尾 JSON 与中间完整坏行应不应该采用相同修复策略？

### 第 1 步：核对显式组合顺序

打开 [`src/persistence-harness.ts`](src/persistence-harness.ts)，逐行核对：

```text
mountAgentLoopTestDependencies(ctx)
register S06 ScriptedLlmAdapter
mount SessionProjectionRegistry
register S04 todoProjection
mount AgentLoop({ agents: [] })
mount JsonlSessionPersistence({ compression: 'none', packChunks: false })
```

这里没有调用 S06 的 `mountKeylessAgentLoop()`。那个 helper 会把 testkit、S05 tool 和 AgentLoop 一次挂完，无法在正确位置显式插入 Projection；S08 需要自己拥有加载顺序。

`@deepseek-ai/dsh-agent-loop-testkit` 仍只挂前置 Service，不包含 AgentLoop、Projection 或 Persistence。

### 第 2 步：观察 Context A 的完整 Turn

打开 [`src/persistence-lab.ts`](src/persistence-lab.ts)。Context A 的 adapter 返回一段确定文本；`agent/turn-stopping` 在 Turn 仍开放、Step 已结束的位置追加：

```ts
agent.session.append('todo/write', { todos })
```

随后：

```ts
await handle.agent.whenIdle()
await ctx.sessions.flush(handle.agent.session)
```

测试要求 `flush()` 返回 `true`，并把 `readRaw()` 中 header 后的每行与 `session.events` 逐项比较。

### 第 3 步：亲眼读 plaintext JSONL

运行：

```bash
corepack pnpm exec tsx s08_jsonl_persistence/src/demo.ts
```

场景结束会安全删除临时目录，所以若要手工停留观察，可以在本地临时给 [`removeScenarioRoot()`](src/jsonl-fixtures.ts) 前加一个断点，而不是改成删除某个更宽目录。

工件路径由后端 `locate(session.header)` 返回，形态是：

```text
<mkdtemp root>/_no-cwd/s08-jsonl-round-trip/session.jsonl
```

header 不携带 `seq`；第一条事件仍是 seq 0。

### 第 4 步：确认 A 完全退出后才启动 B

正向代码先执行：

```text
handleA.dispose()
ctxA.fiber.dispose()
```

然后才 new `Context B`。这不是模拟进程级 crash，而是验证正常关闭后的冷恢复。一个 session 同时只有一个 active writer；不要在 A 尚未完全 dispose 时让 B 写同一文件。

### 第 5 步：观察 resume 的三个等式

Context B `agents.resume()` 返回后、发送新消息前，验证：

```text
events.slice(0, firstLiveSeq) == Context A events
deriveMessages()              == Context A messages
todo projection               == Context A todos
```

并验证：

```text
events[firstLiveSeq].type == 'session/end-seed'
events[firstLiveSeq].seq  == firstLiveSeq
```

Projection Registry 没有持久化第二份 todo 状态；它从恢复 seed lazy fold 得到相同 whole value。

### 第 6 步：从 Turn 1 继续到 Turn 2

Context B 再 `followup()` 一条消息。AgentLoop 从恢复 trace 得知 Turn 1 已结束，所以新的 `turn/start.data.turn` 是 2。

第二次 flush 后，测试把物理 JSONL 事件行与最终 live events 再比较一次，并断言：

```text
seq == [0, 1, 2, ..., events.length - 1]
turn == [1, 2]
```

### 第 7 步：做自己的正向修改

修改 `persistedTodos` 的内容或状态，再运行：

```bash
corepack pnpm exec vitest run s08_jsonl_persistence/tests/persistence.test.ts
corepack pnpm exec tsx s08_jsonl_persistence/src/demo.ts
```

先观察测试因旧期望而变红，再同步更新期望。重点不是某句 todo 文案，而是 A、B 和最终 Projection 始终一致。

## 负向实验

### 负例一：torn tail 只丢半条记录

[`runTornTailScenario()`](src/recovery-lab.ts) 先通过真实 Session 与 Persistence flush 四个完整事件：

```text
turn/start
step/start
user/message
assistant/message
```

它故意不写 `step/end` / `turn/end`，模拟进程在边界提交前停止。关闭第一个 Context 后，再向精确 artifact path 追加一段没有换行的半条 JSON：

```text
{"course_torn_probe":"HALF-WRITTEN
```

resume 的正确结果：

1. 丢弃且只丢弃这个 incomplete fragment；
2. 四个完整事件逐项保留，两个 message identity 与内容不变；
3. 追加 `step/end`；
4. 追加 `turn/end { reason: { kind: 'interrupted' } }`；
5. seeded Session 再在新的 `firstLiveSeq` 位置追加 `session/end-seed`；
6. flush 后物理 JSONL 与修复后的 live log 一致。

`inspect()` 可以只在内存合成视图而不提交修复；本实验使用 `agents.resume()`，因此 `prepare()` 会在发布前把 truncation 与 closers 真正提交到后端。

### 负例二：committed corruption 必须拒绝

[`runCommittedCorruptionScenario()`](src/recovery-lab.ts) 先写出一个带完整 `turn/end` 的正常 Turn，再把其中一条完整 `assistant/chunk` 行替换成不可解析 JSON。坏行之后仍存在完整的 `turn/end`，所以它已经位于 committed region，不能当作 torn tail 截掉。

验收四件事：

```text
error message 包含 "unparsable committed event"
Agent 未发布
Session 未发布
resume 前后 artifact bytes 完全相同
```

测试有意不绑定具体 Error subclass，原因见“教学简化与生产边界”的 rc.2 观察。

### 临时目录为什么要精确清理

三个场景分别调用 `mkdtemp()`，并只保留它返回的精确路径。`removeScenarioRoot()` 在 `rm(..., { recursive:true })` 前再次验证：

- 父目录必须正好是系统 `tmpdir()`；
- basename 必须以 `learn-dsh-s08-` 开头；
- 不接受环境变量、glob、仓库根或 `tmpdir()` 本身。

清理位于 `finally`，实验成功或失败都不会把 fixture 留在磁盘。

## 预期观察

关键输出如下；路径、时间戳与 message id 每次运行都可能不同：

```text
PASS 1/3：Context A 的完整 Turn 与 todo Projection 经 JSONL 恢复到 Context B
  durable prefix：16 events
  firstLiveSeq / seed marker：16 / 16
  turn：1 → 2
  final seq：0..30

PASS 2/3：torn tail 只丢半条 JSON，完整开放 Turn 被 synthetic closers 平衡
  保留事件：4
  合成事件：step/end → turn/end
  turn/end：interrupted

PASS 3/3：committed corruption 被拒绝，Registry 与原始字节均保持不变
  error：Error: corrupt session log: unparsable committed event at line 8
  publication：Agent=false, Session=false
  artifact bytes：unchanged
```

`16`、`30` 和错误行号来自当前确定脚本与 chunk 数量；学习修改响应后可以变化。真正不变的是 prefix、marker、连续 seq、恢复等式与 fail-closed 结果。

## 对照真实源码

本章运行：

- `@deepseek-ai/dsh-session-persistence-jsonl@0.1.1-rc.2`
- `@deepseek-ai/dsh-session-persistence@0.1.1-rc.2`（JSONL Provider 的 seam peer）
- `@deepseek-ai/dsh-session@0.1.1-rc.2`
- `@deepseek-ai/dsh-session-projection@0.1.1-rc.2`
- `@deepseek-ai/dsh-agent-loop@0.1.1-rc.2`

固定对照 DeepSeek Harness commit `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`：

- [JSONL backend、plaintext append、readRaw 与 repair commit](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/session/session-persistence-jsonl/src/index.ts)
- [JSONL scanner、header/事件行与 committed-region 判定](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/session/session-persistence-jsonl/src/format.ts)
- [`SessionPersistence` seam API](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/session/session-persistence/src/index.ts)
- [`PersistenceCoordinator` prepare、修复、publication 与 write-behind](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/session/session-persistence/src/coordinator.ts)
- [`interruptedTurnClosers` 的工具、Step 与 Turn 修复顺序](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/core/session/src/repair.ts)
- [`Session` seed、firstLiveSeq、marker 与 deriveMessages](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/core/session/src/index.ts)
- [Session Projection Registry](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/session/session-projection/src/index.ts)
- [AgentLoop create/resume factory](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/core/agent-loop/src/index.ts)

所有链接固定到 commit 与文件，不携带易漂移的 `#Lxx`。

## 验收

运行：

```bash
corepack pnpm exec tsx s08_jsonl_persistence/src/demo.ts
corepack pnpm exec vitest run s08_jsonl_persistence/tests
corepack pnpm exec tsc --noEmit
```

通过条件：

- demo 输出 3 项 PASS；
- Context A 与 B 的 flush 都有真实 durability listener 参与；
- Context B 的 durable prefix、messages、todo Projection 与 A 一致；
- `firstLiveSeq`、seed marker、Turn `1 → 2` 与全部 seq 连续；
- torn fragment 消失，完整事件保留，closers 是 `step/end → turn/end(interrupted)`；
- committed corruption 的错误包含稳定行为文本，Agent/Session 未发布，文件字节不变；
- 三个 `mkdtemp` 根都经过 guard 精确删除；
- 实现没有调用 S06 隐藏加载顺序的 helper，也没有绑定 corruption Error subclass。

## 教学简化与生产边界

### rc.2 文档与实现的 corruption Error 差异

`@deepseek-ai/dsh-session-persistence@0.1.1-rc.2` 的公开说明把已提交区解析/校验损坏描述为 `SessionPersistenceCorruptionError`。Coordinator 也确实会把其 `try` 内的 stored-event validation error 包成这个类。

但固定 commit 的 `prepareCore()` 在进入该 `try` 前先执行：

```ts
const stored = await backend.loadStored(id)
```

plaintext JSONL scanner 在 `loadStored()` 内发现坏行，并直接抛普通：

```text
Error: corrupt session log: unparsable committed event at line ...
```

因此这条 rc.2 路径绕过了 Coordinator 的 wrapper。本章黑盒实测也是 `Error`，所以测试只绑定可观察契约——拒绝、稳定消息片段、零 publication、字节不变——绝不写 `instanceof SessionPersistenceCorruptionError`。

这是明确的上游贡献候选：

1. 把 backend read/scan failure 纳入统一 wrapper，兑现文档；或
2. 调整公开文档并提供跨 backend 的稳定 error code；
3. 增加 JSONL committed parse failure 的公共契约测试，防止 backend 之间类型漂移。

在上游决定前，应用也不应依赖这个 rc.2 具体构造器名称做恢复分支。

### 其他生产差异

| 本章做法 | 教学价值 | 生产还需要什么 |
| --- | --- | --- |
| plaintext + unpacked rows | 人能逐行读，能精确注入半条 JSON | 评估 zstd、packing、空间、CPU 与可运维性 |
| 单 writer 先 dispose 后 resume | 隔离身份和恢复语义 | 进程锁、部署 ownership 与跨进程竞争策略 |
| `mkdtemp` 本地根 | 测试相互隔离且可清理 | 明确持久卷、权限、备份、配额与 retention |
| 固定 scripted LLM | 没有 Key 和网络随机性 | 真实 provider 的 request-header 兼容、重试和成本 |
| 只测无悬空工具的 open Step | 聚焦两个 closer | 对有副作用工具验证 `TOOL_OUTCOME_UNKNOWN` 与人工确认 |

### Windows 与 Koffi 边界

仓库依赖策略明确设置 `koffi:false`，本章又只运行 `compression:'none'` 的 CI/macOS/Linux 教学路径。这个实验没有验证 Windows JSONL durability，也不能据此宣称跨平台持久化已经通过。

JSONL backend 在 Windows 的无覆盖、write-through 原子发布路径可能需要该包批准的 Koffi native build。真实 Windows 部署应在完成依赖 trust review 后启用包认可的构建方式，并单独运行 Windows crash/durability 测试；不要从本章的 macOS/Linux PASS 外推结论。

## 上游观察卡

读完固定源码后，用自己的话填写：

```md
- 我观察的 JSONL 物理路径与 header：
- whenIdle 与 flush 的区别：
- Context B 的 durable prefix 如何证明：
- firstLiveSeq 与 session/end-seed 各表示什么：
- deriveMessages 为什么没有额外持久表：
- todo Projection 如何从 seed 恢复：
- torn fragment 被丢弃的最小范围：
- synthetic closer 的顺序与原因：
- committed corruption 为什么不能自动截断：
- rc.2 Error 文档/实现差异：
- 我准备提交的上游测试或修复方向：
- 本章没有覆盖的平台与部署风险：
```

能独立解释“内存 idle 不等于 durable、torn tail 可修、committed corruption 必须拒绝”后，再进入 S09 Background jobs。
