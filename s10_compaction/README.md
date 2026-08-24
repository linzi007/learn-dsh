# 10：Compaction checkpoint——缩短 model-visible history，不删除事实

> 一句话目标：显式调用真实 `BasicCompactionEngine.compactNow()`，观察较早 `surface` 如何被一个 durable checkpoint 遮蔽、最新尾部如何保留，以及同一语义如何经 JSONL 在全新 Context 中恢复。

- 上一章：[09 Background jobs](../s09_background_jobs/)
- 下一章：[11 MCP bridge](../s11_mcp_bridge/)
- API Key：不需要
- 本章核心增量：从“Session 可以重启恢复”走到“上下文可以缩短，但 append-only 事实与 replay 语义仍然保留”

## 问题

Agent 连续工作后，请求历史会越来越长。把所有旧消息继续发给模型，会遇到三类问题：

- 模型 context window 有上限；
- 输入 token、延迟和成本持续增长；
- 大段旧工具结果会挤占真正有用的近期上下文。

最粗暴的处理是删除旧消息。但 Session 又承担 replay、审计和恢复职责：删除以后，“曾经发生过什么”与“为什么得到当前状态”都可能无法回答。

DeepSeek Harness 的 Compaction 把两个视图分开：

```text
append-only log：保留完整事实
model-visible surface：用一个 checkpoint 遮蔽较早范围，再保留近期尾部
```

所以本章的“压缩”不是压缩 JSONL 字节，也不是从日志中删除旧事件；它是对模型可见历史做一次可重放的 `surfaceOp: replace`。

## 先认识九个基本概念

### 1. append-only log 与 `surface` 是两个层次

Session 的 append-only log 记录所有 durable `SessionEvent`。`surface` 是从日志 fold 出来的、有顺序的 model-visible 节点集合：

```text
raw events     turn/start、request/header、message、compaction/* ...
                    |
                    v
surface        user/message、assistant/message、tool/result 的当前可见版本
                    |
                    v
deriveMessages()  下一次模型请求看到的 Message[]
```

成功 Compaction 后，被遮蔽的旧 `user/message` / `assistant/message` 仍能按原 seq 在 raw log 中找到，只是不再由 `deriveMessages()` 返回。

### 2. `CompactionEngine`、`BasicCompactionEngine` 与 `TokenMeter`

三者职责不同：

| 角色 | 本章真实实现 | 职责 |
| --- | --- | --- |
| Service Definition | `CompactionEngine` | 定义 `ctx.compaction`、三个入口、`CompactionResult` 与 `compaction/*` 事件 |
| Service Provider | `BasicCompactionEngine` | 选择安全范围、调用摘要器、验证摘要确实更小、提交或闭合失败事务 |
| Measurement Service | `TokenMeter` | 从 Session replay-aware 地估算当前 surface 与请求压力 |

`TokenMeter` 使用固定启发式估算，不是提供方 tokenizer，也不是账单。本章只用它比较替换前后和判断摘要是否真的缩小了范围。

### 3. 三个入口不是同一种触发

`CompactionEngine` 公开三个操作：

| API | 何时用 | 固定上游的重要约束 |
| --- | --- | --- |
| `compactIfNeeded()` | 自动 pressure 或已确认的 `context-overflow` | 根据策略决定是否需要；无安全范围返回 `null` |
| `compactNow()` | 人类或程序在 Agent idle 时显式触发 | 即使没到压力阈值也尝试；以 maintenance 预留下一轮接纳；事件 `turn: null`；闭合后等待 flush |
| `compactRegion()` | 已知具体 surface 位置时强制压缩 | 要求存在 open turn；边界无效、倒序或拆开 tool pair 时拒绝 |

本章只运行 `compactNow()`，并把 provider 配成 `auto: false`。因此输出中的 Compaction 是一次真实的 manual trigger，不冒充自然 pressure 或真实 provider overflow。

### 4. `shadowedSeqs` 与保留尾部

`BasicCompactionEngine` 从 surface 头部选择较早范围，将其换成一个 checkpoint，同时保留近期尾部。`CompactionResult` 里最重要的字段包括：

- `shadowedRange`：替换区间的两个位置边界；
- `shadowedSeqs`：按 surface 顺序列出的全部被遮蔽节点；
- `shadowedTokenCount`：被遮蔽内容的启发式 token 估算；
- `startSeq` / `summarySeq` / `endSeq`：事务事件的 raw-log seq。

范围是 **surface position span**，不是“两个数字之间所有 seq”。之前的 replacement 可能把一个新生成的高 seq checkpoint 放回旧位置，所以 surface 顺序不保证数值递增。

本章两轮历史的 surface 是：

```text
[4, 12, 19, 25]
```

真实 manual selector 遮蔽 `[4, 12, 19]`，至少保留最新节点 `25`。它不承诺保留完整 Turn；真正不能拆开的是尚未平衡的 assistant tool-call / `tool/result` 配对边界。

### 5. `compaction/start`、`compaction/summary`、`compaction/end`

这三个事件都只进 raw log，不进入 surface：

```text
compaction/start    durable lock，manual owner 是 turn: null
       |
       v
调用 summarizer
       |
       v
compaction/summary  原始摘要、shadowedSeqs、token 与摘要来源
       |
       v
checkpoint user/message + surfaceOp: replace
       |
       v
compaction/end      闭合 durable lock
```

`compaction/end` 在 checkpoint replacement 之后才写入。若进程崩在中间，日志会留下可检测的未匹配 start，而不会虚构一个已成功闭合的结果。

### 6. checkpoint provenance 与唯一 surface mutation

成功事务只有一个事件改变 surface：带 `surfaceOp: replace` 的 `user/message`。它的 source 由 `compactCheckpointSource()` 创建，至少包含：

```ts
{
  kind: 'plugin',
  plugin: 'compact',
  compactionId,
}
```

消费方用 `isCompactCheckpointSource()` 判断来源，而不是猜某个 provider 名称。`BasicCompactionEngine` 还会在内容外增加 checkpoint preamble 与 `<compacted-summary>` 标签，使下一次模型把它当成已经建立的背景。

### 7. 真实摘要器与本章 deterministic FAKE

固定上游的默认 `BasicCompactionEngine` 会直接调用一次 `ctx.llm.stream()`：

- 回放被选范围的真实 system、tools 与 messages；
- 把 compaction instruction 作为最后一条 user message；
- 设置 `purpose: 'compaction'`；
- 只把安全文本写入 checkpoint；
- 在 `compaction/summary` 中记录 provider、model、usage 与调用 provenance。

这次辅助调用不是 AgentLoop 的一个 Step，但会产生真实 token 成本。

本章没有 API Key，也不评估模型摘要质量。为了让事件、范围和失败完全可复现，[`DeterministicFakeSummarizerCompactionEngine`](src/deterministic-fake-summarizer.ts) 继承真实 provider，只覆盖受保护的 `summarize()` hook：

```text
provider = course-deterministic-fake
model    = fixed-summary-v1
summary  = 固定短文本
```

它不设置 `llmStreamCall: true`，因为确实没有通过 `ctx.llm.stream()` 摘要。S06 的 `ScriptedLlmAdapter` 也仍是 fake，只负责无 Key 地生成两轮原始对话。Agent、Session、`TokenMeter`、范围选择、事务、replacement、JSONL 和 resume 都是真实实现。

### 8. `compactNow()`、flush 与 resume

`compactNow()` 先通过真实 Agent 的 maintenance 边界确认它处于 idle，再执行事务。成功或已正常闭合的预期失败都会调用 `ctx.sessions.flush()`；下一轮输入要等这个 durability checkpoint 结束后才能开始。

本章随后完全释放 Context A，在 Context B 中调用 `agents.resume()`：

```text
Context A: compactNow() → flush JSONL → dispose
                                      |
                                      v
Context B: agents.resume() → replay replacement → session/end-seed
```

`session/end-seed` 是新进程生命周期的第一个 live marker；它不进入 surface。恢复前后的 `deriveMessages()`、surface seq 顺序和 checkpoint provenance 必须相同。

### 9. `ManualCompactionError` 与 fail-closed

manual 路径的预期失败使用 `ManualCompactionError`，稳定 code 包括 `busy`、`cancelled`、`changed`、`summary`、`commit`、`persistence`。调用方传入的 signal 中止会保留原始 abort reason；由 Agent maintenance 生命周期触发的取消才归类为 `cancelled`。

本章负例让 deterministic fake summarizer 抛出异常。真实 provider 随后：

```text
compaction/start
compaction/end { error }
```

它不会写 `compaction/summary`，不会写 checkpoint，也不会改变 surface；但已闭合的失败尝试会 flush，因此恢复后仍可审计。若连 `compaction/end` 都无法提交，未匹配 start 会继续充当 durable busy lock，这是比“假装失败已清理”更保守的设计。

## 你会交付什么

本章有两个 assertion-based 实验：

1. 真实 `compactNow()` 遮蔽较早范围、保留最新尾部、写入 JSONL，并在全新 Context 恢复相同 model-visible history。
2. deterministic fake summarizer 失败后，验证 failed bracket durable，但 `compaction/summary`、checkpoint 与 surface mutation 都不存在。

代码与证据：

- [`src/deterministic-fake-summarizer.ts`](src/deterministic-fake-summarizer.ts)：唯一的 compaction fake 与故障开关。
- [`src/compaction-harness.ts`](src/compaction-harness.ts)：真实服务的显式加载顺序。
- [`src/compaction-lab.ts`](src/compaction-lab.ts)：成功、失败、flush 与双 Context resume 场景。
- [`src/demo.ts`](src/demo.ts)：两组运行时断言和可观察输出。
- [`tests/compaction.test.ts`](tests/compaction.test.ts)：范围、事件、provenance、raw log、resume 与负例测试。
- [`tests/chapter-contract.test.ts`](tests/chapter-contract.test.ts)：教学结构和真假边界门禁。

## 机制图

正向路径：

```text
真实 AgentLoop 产生两轮历史
surface [4, 12, 19, 25]       raw log 完整保留
             |
             | ctx.compaction.compactNow(realAgent, signal)
             v
   真实 TokenMeter + range selector
      shadow [4, 12, 19]
      retain [25]
             |
             v
 deterministic FAKE summarize()  ← 唯一 compaction 替身
             |
             v
 start → summary → checkpoint(replace) → end → flush
                     |
                     v
surface [checkpointSeq, 25]      raw log 仍含 4, 12, 19
                     |
                     v
              JSONL / dispose
                     |
                     v
         Context B agents.resume()
                     |
                     v
相同 surface / messages / provenance + log-only session/end-seed
```

失败路径：

```text
start → deterministic FAKE throws → end { error } → flush
                                      |
                                      +-- no compaction/summary
                                      +-- no checkpoint
                                      +-- surface unchanged
                                      +-- resume sees same messages
```

## 本章边界

本章有意只增加 Compaction checkpoint 这一项核心机制：

- 使用 manual `compactNow()`，不伪造小 context window 来冒充 pressure trigger；
- 不运行真实 LLM summarizer，不比较摘要正确率，不产生模型费用；
- 不演示 `context-overflow` adapter 分类与自动 retry；
- 不加载 `dsh-compaction-tool-result-pruner`，不做大型工具结果 prune；
- 不实现 spill locator；spill 与 Compaction 是不同机制；
- 不加载面向人类的 `/compact` command；本章直接调用它底层的公开 Service API；
- 不制造未匹配 start 的 crash recovery；这里只验证成功 bracket 与正常闭合的失败 bracket；
- JSONL 继续采用 S08 的 `compression: 'none'`、`packChunks: false`，继承其 macOS/Linux 验证边界；当前 `koffi:false`，没有验证 Windows durability 或 Koffi native build。

## 手把手实验

### 第 0 步：先预测

运行前先回答：

1. Compaction 会不会让 raw log 中原来的消息消失？
2. `compaction/summary` 自己是不是 model-visible surface 节点？
3. 两轮四个 message 节点经过本章 manual selector 后，会保留完整第二轮还是只保留最新节点？
4. 摘要器抛错后，应该完全没有 durable 证据，还是留下失败 bracket？
5. resume 后 checkpoint source 还可以被 `isCompactCheckpointSource()` 识别吗？

### 第 1 步：先标出真假边界

打开 [`src/deterministic-fake-summarizer.ts`](src/deterministic-fake-summarizer.ts)，确认类名、provider 和注释都明确写着 `FAKE`。

再打开 [`src/compaction-harness.ts`](src/compaction-harness.ts)，按顺序找到：

1. `mountAgentLoopTestDependencies(ctx)`；
2. 注册 S06 `ScriptedLlmAdapter`；
3. `AgentLoop`；
4. `JsonlSessionPersistence`；
5. `TokenMeter`；
6. `DeterministicFakeSummarizerCompactionEngine`，配置 `auto: false`。

不要把“子类名里有 Engine”理解为课程重写了 Compaction。它继承真实 `BasicCompactionEngine`，只覆盖一个 protected hook。

### 第 2 步：跟踪压缩前的 surface

打开 [`src/compaction-lab.ts`](src/compaction-lab.ts)，找到 `seedTwoTurns()`。两次 `followup()` 都由真实 AgentLoop 完成，S06 adapter 只替代模型响应。

压缩前分别记录：

- raw `session.events`；
- `session.deriveMessages()`；
- `session.surface.nodes`；
- `ctx.tokenMeter.measure(session).surfaceTokens`。

四个 surface seq 是 `4, 12, 19, 25`，它们不是第 4、12、19、25 个“模型轮次”，而是对应 message 事件在完整 raw log 中的 seq。

### 第 3 步：找到唯一触发语句

核心调用只有：

```ts
await ctxA.compaction.compactNow(
  handleA.agent,
  new AbortController().signal,
)
```

传入的是 AgentRegistry 创建的真实 Agent，不是只带 `{ session }` 的 fake。调用发生在两轮都 `whenIdle()` 之后。

### 第 4 步：逐项核对 `CompactionResult`

运行：

```bash
corepack pnpm demo:s10
```

先核对：

```text
shadowed seqs：4, 12, 19
retained seqs：25
surface tokens：1470 → 126
```

token 数是固定启发式估算，只用于本场景内比较；不要把 `1470` 当成模型账单。

### 第 5 步：找出五段事务顺序

`CompactionResult` 只直接给出 start、summary、end 三个 seq。测试另外找到 checkpoint event，验证：

```text
startSeq < summarySeq < checkpointSeq < endSeq
```

其中只有 checkpoint 带 `surfaceOp: replace`。三个 `compaction/*` 事件都不允许带 surface operation。

### 第 6 步：比较 raw log 与 model-visible history

成功后同时检查：

- `contextAEvents` 仍以 `beforeEvents` 开头；
- `shadowedSeqs` 指向的旧事件仍存在；
- `deriveMessages()` 从 4 条变成 checkpoint + 最新 assistant 两条；
- surface 从 4 个原始 seq 变成 checkpoint seq + `25`。

这一步是本章最重要的区别：**遮蔽不是删除**。

### 第 7 步：跨 Context 验证 replay

场景随后：

1. 读取真实 JSONL event records；
2. dispose AgentHandle 和 Context A；
3. 在全新 Context B 重新挂载服务；
4. 调用 `agents.resume()`；
5. 比较 durable prefix、`deriveMessages()`、surface 与 checkpoint provenance；
6. 确认 `firstLiveSeq === session/end-seed.seq`。

### 第 8 步：运行自动测试

```bash
corepack pnpm test:s10
```

测试不会只数事件，还会断言 fake 收到的 messages 正好等于被遮蔽的真实 model-visible 前缀。

### 第 9 步：做自己的正向修改

把场景扩成三轮：

1. 给两个 `ScriptedLlmAdapter` 各增加第三个 `textResponse()`；
2. 在 `seedTwoTurns()` 的 prompt 列表中增加一条有独特关键词的长消息，并相应改名；
3. 先预测新的 `shadowedSeqs` 与 retained tail；
4. 更新测试期望；
5. 运行 demo 与 tests。

验收重点不是 seq 数字是否和本章相同，而是“fake 收到的输入 = 真实 shadowed messages”“raw prefix 保留”“resume surface 一致”三条不变式仍成立。

## 负向实验

### 内置负例：summarizer 抛错

`runCompactionFailureScenario()` 在调用前执行：

```ts
engine.failNextSummary()
```

预期：

- 抛 `ManualCompactionError`，`code === 'summary'`；
- cause 保留 `course deterministic fake summarizer failed`；
- raw log 新增 `compaction/start → compaction/end { error }`；
- 没有 `compaction/summary`；
- 没有 checkpoint；
- surface 和 `deriveMessages()` 不变；
- failed bracket 仍被 JSONL flush，并能在 Context B resume。

### 亲手故障注入：让摘要不再更小

把 `FAKE_SUMMARY_TEXT` 临时改成非常长的文本，例如：

```ts
export const FAKE_SUMMARY_TEXT = '故意过长的摘要'.repeat(2_000)
```

再运行：

```bash
corepack pnpm test:s10
```

真实 `BasicCompactionEngine` 会拒绝 `framed summary token count >= shadowedTokenCount`，而不是提交一个越压越大的 checkpoint。恢复短摘要后重新运行直到全绿。

这类失败仍归为 `ManualCompactionError.code === 'summary'`；分类描述的是“没能产出可提交的小摘要”，不只包含网络或模型异常。

## 预期观察

`corepack pnpm demo:s10` 的关键输出：

```text
PASS 1/2：真实 compactNow 将较早 surface 替换为 durable checkpoint，resume 后语义一致
  trigger：compactNow()（manual，turn=null）
  summarizer：course-deterministic-fake（教学 FAKE，不是模型）
  shadowed seqs：4, 12, 19
  retained seqs：25
  surface tokens：1470 → 126
  lifecycle：compaction/start → compaction/summary → compaction/end
  raw summary text：[教学 FAKE 摘要] 已保留较早对话中的课程目标与关键决定。
  resume：durable prefix 32 events + session/end-seed@32

PASS 2/2：摘要失败写入 durable failed bracket，但不替换 surface
  error：ManualCompactionError(summary): manual compaction could not produce a smaller summary
  cause：course deterministic fake summarizer failed
  lifecycle：compaction/start → compaction/end
  summary/checkpoint：false / false
  surface seqs：4, 12, 19, 25（失败前后及 resume 后一致）
```

第二个 `PASS` 表示负向探针捕获了 fail-closed 语义，不表示摘要失败是期望的生产状态。

## 对照真实源码

本章运行以下公开包，版本均为 `0.1.1-rc.2`：

- `@deepseek-ai/dsh-compaction@0.1.1-rc.2`
- `@deepseek-ai/dsh-compaction-basic@0.1.1-rc.2`
- `@deepseek-ai/dsh-token-meter@0.1.1-rc.2`
- `@deepseek-ai/dsh-session-persistence-jsonl@0.1.1-rc.2`
- `@deepseek-ai/dsh-agent-loop@0.1.1-rc.2`
- `@deepseek-ai/dsh-session@0.1.1-rc.2`

课程固定到 DeepSeek Harness commit `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`：

- [`CompactionEngine` Service API](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/compaction/compaction/src/index.ts)
- [`CompactionResult` 与 durable event map](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/compaction/compaction/src/types.ts)
- [checkpoint source 与 predicate](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/compaction/compaction/src/checkpoint.ts)
- [`BasicCompactionEngine` 入口与策略](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/compaction/compaction-basic/src/index.ts)
- [范围选择、事务、replacement 与失败分类](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/compaction/compaction-basic/src/region.ts)
- [默认 `llm.stream()` summarizer 与 checkpoint framing](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/compaction/compaction-basic/src/summarizer.ts)
- [`TokenMeter` replay-aware measurement](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/llm/token-meter/src/index.ts)
- [上游 manual compaction 行为测试](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/compaction/compaction-basic/tests/manual-compaction.spec.ts)

链接固定到文件，不使用浮动分支或易漂移行号。课程没有复制 provider；deterministic fake 通过上游明确提供的 protected `summarize()` seam 接入。

### 已发现的上游贡献候选：subclass hook 的发布类型入口

`BasicCompactionEngine` 把 protected `summarize()` 记录为唯一 subclass hook，但固定发布包存在一个 packaging / public typing 缺口：

- manifest 声明 `"./src/*": "./src/*"`；
- 发布 `files` 只包含 `lib/index.js`、`lib/invariant.js` 和 `lib/types/**/*.d.ts`，没有 `src/`；
- `SummarizationInput` 与 `SummaryResult` 没有从包根导出。

最小复现：

```bash
node --input-type=module -e "await import('@deepseek-ai/dsh-compaction-basic/src/summarizer.ts')"
```

固定版本实际返回 `ERR_MODULE_NOT_FOUND`。这不会破坏本章已验证的 Compaction 事务，但会让外部 summarizer provider 难以稳定命名 hook 的参数和返回类型。

本章没有依赖这个失效的 deep import，而是在 fake 文件中声明了相同的最小结构形状。适合上游贡献的修正方向是：从根或稳定 `./summarizer` subpath 导出两个类型，并同步修正 `./src/*` 的发布承诺；先整理最小仓库或 Discussion，不把它描述成“Compaction 无法工作”。

## 验收

运行：

```bash
corepack pnpm demo:s10
corepack pnpm test:s10
```

| 状态 | 判定 |
| --- | --- |
| Pass | 能解释 raw log、surface 与 `deriveMessages()` 的区别；能复述成功五段事务；亲手完成一次正向修改和一次负向注入；测试与 demo 全绿；能说明 resume 为什么不需要重新摘要 |
| Fix | 程序能跑，但把 `compaction/summary` 当成 surface 节点、把启发式 token 当账单，或说不清 fake 只替换了哪个 seam |
| Not yet | 认为 Compaction 删除原事件；把固定文本冒充真实模型摘要；失败后仍提交 checkpoint；只看 demo 输出而没有运行故障注入 |

完成后，用自己的话回答：**为什么 JSONL 里同时保留原消息和 checkpoint，却不会在 resume 后把两份内容都发送给模型？**

## 教学简化与生产边界

- `ScriptedLlmAdapter` 与 deterministic summarizer 都是明确的 fake；本章证明真实编排语义，不证明任何模型的摘要质量。
- 固定摘要短到足以通过真实 shrink guard；生产摘要还要评估事实保留、指令污染、敏感信息、结构稳定性和重试成本。
- 默认 summarizer 是一次独立 `llm.stream()` 调用，不是免费的，也不经过普通 Agent Step；监控与成本归因应识别 `purpose: 'compaction'`。
- 默认 summarizer 会接收当前请求的 system prompt、tool schemas 与被选中消息；若摘要 provider 与主会话 provider 不同，要单独评估隐私、合规与数据驻留。
- 本章用 `compactNow()` 排除 pressure policy 的容量变量。生产自动压缩还依赖 adapter 提供的 context window、`thresholdRatio`、`retainRatio` / `retainTokens` 与 overflow 分类。
- 真实范围按 surface position 和工具配对安全边界选择，不按 Turn 整块保留；不要从本章四个 seq 推导通用固定数量。
- manual 已闭合失败会 durable flush；未匹配 start、commit 部分失败与磁盘 flush 失败需要分别处理，不能统一当“重试一次就好”。
- `runMaintenance()` 阻止新 Turn 接纳，不会冻结所有 Session append；并发注入可能落在 marker pair 中，事务只承诺被选范围保持稳定。
- Compaction 缩短 model-visible surface，但不能缩短 system prompt、tool schemas 等 request envelope，也不能修复单个不可分大节点。
- 本章不覆盖 tool-result pruner 或 spill。二者可以和 Compaction 组合，但不是同一个 surface-summary 事务。
- 本地 clean path 只验证课程当前 macOS/Linux 配置；不能据此宣称 Windows JSONL durability、Koffi native path 或生产文件系统故障已经验证。

## 上游观察卡

完成实验后复制并填写：

```text
观察对象：@deepseek-ai/dsh-compaction-basic / compactNow + durable replacement / b150a551b8...
预期行为：
实际行为：
复现命令：corepack pnpm test:s10
原始事件证据：
surface / deriveMessages 证据：
resume 证据：
分类：学习误解 / 文档歧义 / 兼容性问题 / 可复现缺陷 / 插件机会
下一步：留在课程 / 写指南 / 发布 summarizer provider / 发 Discussion
```

如果只是 deterministic fake 的摘要内容太长或测试预期写错，先留在课程修正。只有真实范围选择、事务顺序、flush 或 replay 在固定版本与最小复现中违背公开契约，才整理成上游反馈。
