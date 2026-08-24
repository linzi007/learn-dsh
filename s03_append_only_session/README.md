# 03：Append-only session——让历史只能追加，不能改写

> 一句话目标：直接使用真实 `Session.append()`，证明已接受事件连续、不可改写，失败追加不污染日志。

- 上一章：[02 Service seam](../s02_service_seam/)
- API Key：不需要
- 本章核心增量：从“能力如何组合”转向“Agent 运行事实如何可靠记录”
- 下一章：[04 Projection replay](../s04_projection_replay/)

本章直接使用真实的 `@deepseek-ai/dsh-session@0.1.1-rc.2`。实验代码只调用公开 API 并收集观察结果，没有重写一个教学版 Session。

## 问题

Agent 会不断产生用户输入、模型输出、工具调用和运行状态。如果日志直接保存调用方传入的对象引用，调用方之后的一次普通修改就可能改写已经接受的历史；如果失败的追加仍然消耗序号，日志会留下空洞；如果读取者拿到的是持续增长的内部数组，它在遍历时看到的内容还可能悄悄变化。

本章只解决一个问题：一次事件被 Session 接受之后，如何保证它成为一条连续、不可改写的历史记录；一次事件没有通过检查时，又如何保证日志完全不变。

## 先认识六个基本概念

### 1. Append-only log：只追加的原始日志

`Session` 内部保存按接受顺序排列的 event log。append-only 的意思不是“每次调用都必须成功”，而是：已经提交的事件只能保留，后续状态变化要追加新事件，不能回头覆盖旧事件。

### 2. Event envelope：事件信封

每个已接受事件都有 `type`、`seq`、`time` 和 `data`：

```text
{ type, seq, time, data }
```

`seq` 从 `0` 开始，由 Session 分配。`session.seq` 表示下一条事件将使用的序号，也等于当前日志长度；它不是“最后一条事件的序号”。`time` 来自主机时钟，本章不依赖或断言它的具体值。

### 3. Lossless JSON snapshot：先校验，再脱离调用方对象

`append()` 会在一次遍历中检查并复制 `data`。接受普通 JSON 标量、稠密数组、普通对象和 null-prototype 对象；拒绝 `BigInt`、`undefined`、非有限数、`-0`、函数、Symbol、循环引用、稀疏数组以及 `Map`、`Set`、`Date`、class instance 等特殊对象。

这里比“`JSON.stringify()` 没报错”更严格，因为 Session 要保证写出并重新读取后不会丢失或改变信息。

### 4. Deep freeze：接受后的历史不可写

进入日志的是脱离调用方的副本，并且 event、`data`、数组和嵌套对象都会被冻结。调用方仍可修改自己的原对象，但不能借它改写日志；直接修改已记录对象则会抛出 `TypeError`。

### 5. `events` snapshot：读取到的是稳定视图

`session.events` 不是内部可变日志数组，而是一个冻结快照。同一状态下重复读取会复用同一个数组；成功 append 后缓存失效，下一次读取获得新快照。之前持有的旧快照不会随着新事件增长。

### 6. Fail-before-commit：失败不留下半条记录

Session 先制作候选事件并完成检查，再把它放进日志。`BigInt` 等非法数据会在 commit 前被拒绝，因此日志长度、下一序号和已有 `events` 快照都保持不变。随后一次合法追加仍然获得原本应该使用的 seq。

还有一个容易混淆的创建细节：本章使用 `Session.create(SessionId('s03-demo'))`，不传 seed。`Session.create(id, [])` 表示“从一个显式的空 seed 恢复”，会追加 `session/end-seed` 标记；seed 和 replay 留到后续章节。

## 你会交付什么

- 一个使用真实 DSH `Session` 的 keyless demo：[src/demo.ts](src/demo.ts)。
- 一个可复用的实验函数：[src/session-lab.ts](src/session-lab.ts)。
- 五个自动测试，覆盖连续 seq、输入快照、深冻结、失败前提交和缓存快照：[tests/session.test.ts](tests/session.test.ts)。
- 一次自己的小改动：追加第二份 todo 快照，并证明第一份历史仍然存在。

## 机制图

```text
调用方 data
    |
    v
lossless JSON 校验 + detached snapshot
    |                          \
    | 通过                      \ 失败
    v                            v
分配 seq = log.length        抛错并退出
补充 time，deep freeze          |
    |                            +--> log / seq / events snapshot 均不变
    v
候选事件检查
    |
    v
commit: log.push(event)
    |
    +--> 旧 events snapshot 保持原样
    +--> 缓存失效，下次读取生成新的冻结 snapshot
```

## 本章边界

本章包含：

- detached `Session` 的创建；
- 非 surface 事件的同步追加；
- 连续 seq、数据快照、深冻结和 `events` 缓存快照；
- 非法 JSON 值的 fail-before-commit 行为。

本章不包含：

- 模型可见消息投影与后续 compaction；
- seed、replay、fork 和 `session/end-seed`；
- `SessionStore`、fiber 绑定、observer 与 `flush()`；
- JSONL、数据库或其他持久化实现；
- turn/step 闭合和 tool call/result 配对等关系检查。

关系检查属于可选的 `@deepseek-ai/dsh-session/invariant` companion，不是 detached 根 Session 的全部默认行为。本章仍按 `turn/start` → `todo/write` → `turn/end` 排列事件，但不展开 companion。

`todo/write` 只是一个带嵌套数组、且不需要 surface 参数的真实事件，方便观察快照和冻结；本章不讨论 todo 的 last-write-wins 投影语义。

## 手把手实验

### 第 1 步：安装课程依赖

在仓库根目录执行：

```bash
corepack pnpm install
```

课程固定使用 `@deepseek-ai/dsh-session@0.1.1-rc.2`。它会带入同版本的 DSH peer packages；无需 clone 或构建整个 DeepSeek Harness 仓库。

### 第 2 步：先预测前三个数字

打开 [src/session-lab.ts](src/session-lab.ts)，找到第一次合法追加：

```ts
const start = session.append('turn/start', { turn: 1 })
```

再找到紧随其后的 `todo/write`。运行前先写下你的预测：两条 event 的 `seq` 分别是多少？此时 `session.seq` 又是多少？

答案应是 `0`、`1` 和 `2`。Session 将当前 `log.length` 分配给候选事件；提交后长度才增加。

### 第 3 步：运行完整轨迹

```bash
corepack pnpm demo:s03
```

逐行核对：

1. 两次合法 append 得到 `seq=0`、`seq=1`。
2. 第一次 `events` 快照长度为 2，而且被冻结和缓存。
3. 调用方把原始 todo 改成 `caller mutated` 后，日志仍保留 `understand append-only`。
4. 非法追加被拒绝，长度和下一 seq 仍为 2。
5. `turn/end` 继续获得 `seq=2`，旧快照保持长度 2，新快照长度为 3。

### 第 4 步：让测试检查你的理解

```bash
corepack pnpm test:s03
```

测试不依赖控制台文字来证明核心行为；它会直接检查事件、引用身份、冻结状态和失败前后的 seq。

### 第 5 步：做一次自己的临时修改

在 `turn/end` 之前再追加一条合法 `todo/write`，把状态改成 `in_progress`：

```ts
session.append('todo/write', {
  todos: [{ content: 'understand append-only', status: 'in_progress' }],
})
```

先运行测试观察哪些 seq、length 和 trace 预期需要更新，再补一条断言：第一条 `todo/write` 的 `status` 仍然是 `pending`。只有“追加一条新事实”，没有“修改上一条事实”，才算完成这个练习。

记录你的修改和验证结果后，撤销这次临时改动，再运行 `corepack pnpm test:s03`。下面的“预期观察”描述的是恢复后的三事件课程基线；如果选择永久保留自己的扩展，就要同步维护 demo 输出与全部断言。

## 负向实验

实验故意构造了类型系统不会允许的 payload：

```ts
session.append('todo/write', {
  todos: [],
  unsupported: 1n,
} as never)
```

`as never` 不是生产写法。这里刻意绕过 TypeScript，验证来自外部 JSON、文件、插件或不受信任边界的数据到达 runtime 时仍会被拒绝。

失败前先持有：

```ts
const beforeSnapshot = session.events
const nextSeqBeforeRejected = session.seq
```

失败后必须同时成立：

```text
session.events === beforeSnapshot
session.events.length === 2
session.seq === nextSeqBeforeRejected
```

如果想再做一个边界实验，可将 BigInt 换成循环引用。主线只保留一个负例，因为两者验证的是同一条 lossless-JSON gate。

## 预期观察

恢复临时修改后，demo 的课程基线输出应为：

```text
S03：Append-only session
append:turn/start seq=0
append:todo/write seq=1
snapshot:length=2 frozen=true cached=true
recorded:understand append-only
invalid:rejected message=session event "todo/write" carries non-JSON-serializable data
after-invalid:length=2 seq=2 same-snapshot=true
append:turn/end seq=2
snapshots:old=2 new=3 replaced=true
seq-contiguous=true
```

输出故意不打印 `time`，因为墙上时钟不是确定性验收信号。

## 对照真实源码

本章以 DeepSeek Harness `0.1.1-rc.2`、commit `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e` 为准：

- [`Session.create`、`Session.events`、`Session.seq`、`Session.append`](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/core/session/src/index.ts)：真实接受和 commit 顺序。
- [`SessionEventMap`、`SessionEvent`](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/core/session/src/types.ts)：事件词汇与 envelope。
- [`snapshotJsonValue`](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/core/session/src/json.ts)：无损 JSON 校验和 detached snapshot。
- [Session 行为测试](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/core/session/tests/session.spec.ts)：非法值拒绝、输入隔离、深冻结和缓存快照证据。
- [Session property tests](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/core/session/tests/properties.spec.ts)：零起点连续 seq 的生成式验证。
- [可选 session invariant companion](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/core/session/src/invariant.ts)：本章明确不冒充根 Session 行为的关系检查层。

不要从这些文件复制实现。课程直接运行发布包，只用固定链接解释观察结果。

## 验收

完成后逐项自检：

- [ ] 我能解释 append-only 不等于“所有 append 都成功”。
- [ ] 我能解释 event `seq` 与 `session.seq` 的区别。
- [ ] 我能指出调用方对象、已记录 event 和 `events` 数组分别是否可变。
- [ ] 我能证明失败追加没有改变 length、seq 或 snapshot identity。
- [ ] 我完成了第二条 todo 快照的小改动，并证明第一条历史没有变化。
- [ ] `corepack pnpm test:s03` 通过。

结论分级：

| 结论 | 标准 |
| --- | --- |
| `Pass` | demo 和测试通过；能独立解释五个不变式；完成自己的第二次合法追加。 |
| `Fix` | 能跑通，但仍把 `session.seq` 当成最后序号，或把 `events` 当成会实时增长的数组。 |
| `Not yet` | 没有负向证据，或失败追加后 length／seq／snapshot 发生了变化。 |

这里的五个不变式是：连续 seq、输入隔离、深冻结、稳定快照和 fail-before-commit。

## 教学简化与生产边界

- 使用的 `Session`、事件类型、JSON 校验、冻结和缓存行为都来自真实发布包；教学层只编排调用和记录 trace。
- 使用 detached `Session.create()`，因此没有 store 发布、fiber 所有权、observer 或持久化检查点。需要这些能力时应通过 `ctx.sessions.create()` 创建 live session。
- 只追加非 surface 事件，避免提前引入模型可见投影。生产中的 `user/message`、`assistant/message` 和 `tool/result` 还必须携带合法的 `surfaceOp`。
- 没有加载 `@deepseek-ai/dsh-session/invariant`，因此本章不声称自动检查 turn/step 闭合或 tool pairing。
- 日志只在内存中。append-only 不等于 durable；JSONL persistence 会在后续章节单独实现。
- 没有传 seed。显式 seed 会进入 replay 路径并可能产生 `session/end-seed`，不属于本章。

## 上游观察卡

每次怀疑上游行为有问题时，先填完这张卡，不要只凭一次报错下结论：

```text
基线版本 / commit：0.1.1-rc.2 / b150a551b8d465e31e418e1b2eaf5e79bbb7d28e
观察的公开 API / symbol：
最小复现命令：
输入事件与调用顺序：
预期行为：
实际行为：
是否能稳定复现：
相关固定源码链接：
判断：学习误解 / 课程缺口 / 上游文档歧义 / 可能的上游缺陷
下一步：补课程测试 / 提课程 Issue / 整理后发上游 Discussion / 无需动作
```

本章当前观察结论：非法 BigInt 在 commit 前被拒绝，旧 snapshot 保持同一引用，后续合法事件继续使用 `seq=2`；行为与公开源码和上游测试一致，不构成上游缺陷。
