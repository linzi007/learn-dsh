# 04：Projection replay——从事件日志派生可重算状态

> 一句话目标：直接使用真实 `SessionProjectionRegistry`，让同一个纯 `apply` 在 live incremental、manual full fold 与 seed replay 三条路径上得到相同 todo 列表。

- 上一章：[03 Append-only session](../s03_append_only_session/)
- API Key：不需要
- 本章核心增量：从“可靠记录事实”走到“从事实派生可丢弃、可重算的当前状态”
- 下一章：[05 Tool contract](../s05_tool_contract/)

## 问题

S03 已经把 `turn/start`、`todo/write`、`turn/end` 追加成不可改写的事件日志。日志适合回答“发生过什么”，但界面或业务逻辑通常想直接读取“当前 todo 列表”。

最直接的做法是另外维护一个可变数组；问题是：进程重启、读取历史 Session 或代码升级后，这个数组从哪里恢复？如果 live 路径和恢复路径各写一套逻辑，它们迟早会不一致。

Projection 的答案是：

```text
不可变事件日志 + 同一个纯 transition = 可重算的当前状态
```

当前状态不是第二份事实源。必要时可以丢掉它，再从日志 fold 一遍得到相同结果。

## 先认识八个基本概念

### 1. 事件日志与 Projection

事件日志记录事实：

```text
turn/start → todo/write(v1) → todo/write(v2) → turn/end
```

Projection 是对这段日志的派生计算。本章只关心 `todo/write`；`turn/start`、`turn/end` 和 replay 的 `session/end-seed` 都必须安全忽略。

### 2. `ProjectionDefinition`：一个领域的计算单元

`ProjectionDefinition` 不是一个已经算好的值，而是一份计算说明：

```ts
{
  key,
  stateSchema,
  init,
  apply,
  wire,
  stateVersion,
}
```

框架负责何时驱动、缓存和读取；领域代码只负责纯计算。

### 3. `key`、`init`、`apply`

- `key`：这份 Projection 的唯一名字，本章是 `course/todos`。
- `init()`：空日志的初始状态，本章返回 `[]`。
- `apply(state, event)`：旧状态与一个事件产生新状态。

本章的核心 transition 只有两条规则：

```ts
if (event.type !== 'todo/write') return state
return event.data.todos.map(todo => ({ ...todo }))
```

`todo/write` 携带完整列表，所以最新 whole value 直接胜出；无关事件必须返回原来的引用。

### 4. `stateSchema` 与 `wire.view`

两者解决不同边界：

- `stateSchema` 描述并验证 Registry 内部的 host state，尤其用于持久化 cache 的恢复边界。
- `wire.view(state)` 把 host state 转为对外可见值。
- `wire.viewSchema` 在值离开 Registry 前验证它。

本章的 host state 和对外值都是 `TodoItem[]`，但仍显式复制列表，避免调用方拿到 Registry 的 live 引用。真实项目中，host state 可以包含不对外公开的字段，而 `wire.view` 只发布需要的部分。

### 5. Registry 与 `register`

`SessionProjectionRegistry` 是真实 DSH Service，暴露为 `ctx.sessionProjections`。本章先挂载它，再注册 Definition：

```ts
root.sessionProjections.register(todoProjection)
```

`register` 把 Definition 交给框架，并返回卸载能力；注册本身也是调用方 Fiber 的 Effect。Registry 不是领域规则的拥有者，领域规则仍在 Definition 中。

### 6. live incremental 与 lazy full fold

同一个 Definition 有两种框架驱动方式：

- live incremental：Session 正在追加事件时，Registry 每次只把新事件交给 `apply`。
- lazy full fold：某个 Session 还没有缓存 cell，第一次读取时，从 `init()` 开始把已有日志完整 fold 一遍。

本章的 detached seed replay 不会通过 live 事件总线逐条通知；第一次 `snapshot(replay)` 时，Registry 才 lazy fold 它的完整日志。

### 7. `snapshot` 与 `asOfSeq`

```ts
const snapshot = root.sessionProjections.snapshot(session)
```

返回：

- `values`：所有已注册、对外可见的 whole values；
- `asOfSeq`：这些值共同覆盖到日志的哪个 seq；空日志是 `-1`。

`snapshot` 是一致读取，不是把事件日志复制一份。

### 8. `onChanged` 与 `Object.is`

`onChanged` 只在 live 事件使状态引用发生变化时通知：

```ts
changed = !Object.is(next, previous)
```

因此：

- 无关事件返回原引用，不通知；
- 相关事件返回新引用，通知；
- 原地修改后返回同一引用，值虽然变了，通知却会沉默。

`onChanged` 不是持久化完成信号，也不会为 lazy full fold 补发历史通知。

## 你会交付什么

本章完成两个实验：

1. 对同一段真实 `todo/write` 日志比较 live incremental、manual full fold 和 seed replay，证明三路领域值相同。
2. 使用原地 `splice` 的错误 Definition，证明 state 已变化但 `onChanged` 为零。

代码与证据：

- [`src/todo-domain.ts`](src/todo-domain.ts)：Projection Definition、纯 fold 和教学负例。
- [`src/projection-lab.ts`](src/projection-lab.ts)：真实 Registry、三路比较与通知探针。
- [`src/demo.ts`](src/demo.ts)：带断言的可观察输出。
- [`tests/projection-replay.test.ts`](tests/projection-replay.test.ts)：一致性、watermark、通知与负例测试。

## 机制图

```text
S03 已认识的 append-only events
  seq 0  turn/start                         （无关）
  seq 1  todo/write: [pending]              （whole value v1）
  seq 2  todo/write: [completed, in_progress]（whole value v2）
  seq 3  turn/end                           （无关）
                    |
                    v
          同一个 todoProjection.apply
             /             |             \
            v              v              v
 live incremental   manual full fold   seed replay
 Registry 逐条驱动   课程显式 reduce     snapshot 时 lazy fold
            \              |              /
             +-------------+-------------+
                           |
                           v
      [completed: append-only, in_progress: replay projection]
```

seed replay 的构造器还会在本实验日志末尾追加：

```text
seq 4  session/end-seed
```

Projection 忽略它，所以领域值不变；`asOfSeq` 仍会前进到 4，因为 watermark 表示日志覆盖位置，不表示 todo 最后一次变化的位置。

## 本章边界

本章只学习一个 `ProjectionDefinition`、一个 Registry 和一段进程内事件日志。

有意不进入：

- projection checkpoint / restore 与持久化 cache；
- schema migration 和 `stateVersion` 升级策略；
- 多个 Projection 的一致性 cut；
- UI carrier、RPC 和真实 `tool-todo` Plugin composition；
- Session 重启恢复与损坏日志修复。

课程复用核心包已经定义的 `todo/write`，没有新增 Session event augmentation；只为原创的 `course/todos` key 增加 projection type map。

## 手把手实验

### 第 0 步：先预测

运行前回答：

1. 第二次 `todo/write` 应该合并第一份列表，还是完整替换？
2. `turn/start` / `turn/end` 会不会触发 todo 的 `onChanged`？
3. seed replay 多出 `session/end-seed` 后，领域值和 `asOfSeq` 各会怎样？
4. 原地修改数组后返回同一引用，Registry 能否发现变化？

### 第 1 步：连接 S03 的真实事件

打开 [`src/projection-lab.ts`](src/projection-lab.ts)，找到四次 `live.append(...)`。

这里没有 `course/board/set` 或教学专用 noise event。`todo/write` 与 S03 是同一个核心事件；`turn/start` / `turn/end` 就是自然存在的无关事件。

注意第二次 `todo/write` 仍传入完整列表，而不是“把第一项改为 completed”这种 delta。

### 第 2 步：逐字段读 Definition

打开 [`src/todo-domain.ts`](src/todo-domain.ts)，按这个顺序阅读：

1. `TODO_PROJECTION_KEY`
2. projection type map augmentation
3. `todoStateSchema`
4. `init`
5. `apply`
6. `wire.view`
7. `stateVersion`

先只记住主干：空日志是 `[]`；相关事件返回新 whole value；其他事件返回原引用。

### 第 3 步：找三条计算路径

回到 `runProjectionReplayScenario()`：

- `snapshot(live)` 读取 live incremental 结果；
- `manualFullFold(todoProjection, live.events)` 显式从 `init` 全量 fold；
- `Session.create(..., live.events)` 加 `snapshot(replay)` 触发 seed replay 的 lazy full fold。

三条路径没有三份 transition；都调用同一个 `todoProjection.apply`。

### 第 4 步：运行 demo

```bash
corepack pnpm demo:s04
```

先比对三行 JSON 是否相同，再看：

- live event seq 是 `0..3`；
- replay 末尾多 `session/end-seed`；
- `onChanged` 只记录 seq `1, 2`。

### 第 5 步：运行自动测试

```bash
corepack pnpm test:s04
```

测试同时验证空日志、latest whole value、三路一致性、watermark、通知次数和原地修改负例。

### 第 6 步：做自己的正向修改

修改第二次 `todo/write` 的完整列表，例如再增加一项：

```ts
{ content: 'explain Object.is', status: 'pending' }
```

同步更新测试里的最终 whole value，然后运行：

```bash
corepack pnpm test:s04
corepack pnpm demo:s04
```

验收重点：三条路径仍一致，通知仍只有两次。不要改成只记录“新增一项”的 delta。

## 负向实验

[`createMutatingTodoProjection()`](src/todo-domain.ts) 故意这样做：

```ts
state.splice(0, state.length, ...event.data.todos)
return state
```

Registry 得到的 `next` 和 `previous` 是同一引用，所以 `Object.is` 为 `true`，不会触发 `onChanged`；但 `stateOf()` 和 `snapshot()` 已经能看到被改过的值。这正是危险之处：读取看似正确，依赖通知的 UI 或 carrier 却静默。

亲手做故障注入：

1. 临时把正确 `todoProjection.apply` 改成上述原地 `splice + return state`。
2. 运行 `corepack pnpm test:s04`。
3. 预期通知测试失败：`changes` 为空，而不是 seq `1, 2`。
4. 恢复为返回新数组，重新运行直到全绿。

## 预期观察

关键输出如下：

```text
PASS 1/2：同一个 transition 的三条路径得到同一 todo 列表
  live incremental: [{"content":"understand append-only","status":"completed"},{"content":"replay projection","status":"in_progress"}]
  manual full fold: [{"content":"understand append-only","status":"completed"},{"content":"replay projection","status":"in_progress"}]
  seed replay:      [{"content":"understand append-only","status":"completed"},{"content":"replay projection","status":"in_progress"}]
  live events:      turn/start -> todo/write -> todo/write -> turn/end
  replay events:    turn/start -> todo/write -> todo/write -> turn/end -> session/end-seed
  onChanged seq:    1, 2

PASS 2/2：负向探针捕获“原地修改导致通知沉默”
  before:           []
  after:            [{"content":"状态已改变，通知却沉默","status":"in_progress"}]
  same reference:   true
  onChanged count:  0
```

第二个 `PASS` 表示探针捕获了错误语义，不表示原地修改是正确实现。

## 对照真实源码

本章运行 `@deepseek-ai/dsh-session-projection@0.1.1-rc.2`，固定到 DeepSeek Harness commit `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`：

- [`todo/write` 与 `TodoItem` 核心类型](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/core/session/src/types.ts)
- [`Session.append` 与 seed marker 行为](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/core/session/src/index.ts)
- [`ProjectionDefinition`、Registry、drive 与 lazy cell](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/session/session-projection/src/index.ts)
- [真实 `tool-todo` 如何注册 todos Projection](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/todo/tool-todo/src/index.ts)
- [Registry 的上游契约测试](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/session/session-projection/tests/registry.spec.ts)

这些链接固定到文件而不是易漂移的行号。课程没有复制 Registry，只组合公开包并实现一个原创最小 Definition。

## 验收

运行：

```bash
corepack pnpm demo:s04
corepack pnpm test:s04
```

| 状态 | 判定 |
| --- | --- |
| Pass | 能解释 Definition 七个字段的职责；三路结果一致；能说明两个 `asOfSeq`；正向 whole-value 修改和原地修改负例都完成 |
| Fix | 最终值正确，但说不清 live incremental 与 lazy full fold，或把 `onChanged` 当成持久化完成信号 |
| Not yet | 把 Projection 当第二份事实源，重放路径另写业务逻辑，或相关/无关事件都返回新对象 |

完成后，用自己的话回答：**为什么 replay 日志多一个事件却仍得到相同 todo 列表？为什么 `asOfSeq` 会变化，但 `onChanged` 不一定触发？**

## 教学简化与生产差异

- 本章复用核心 `todo/write`，但使用原创 key `course/todos`，没有直接挂载完整 `tool-todo` Plugin。
- whole-value 表示每次 `todo/write` 都携带完整列表；这使 latest-write-wins fold 简单、可重放。
- Registry 会用同一个 Definition 驱动多个 Session，每个 Session 有独立 cell；本章只展示一条 live 日志和一条 replay 日志。
- `onChanged` 表示 live projection 引用变化，不等于事件持久化完成，也不回放历史通知。
- 构造 seed 只有在最后一项还不是 `session/end-seed` 时才追加 marker；本实验满足这个条件。
- 本章验证进程内计算，不声称已经掌握持久化 cache、恢复、损坏修复或 schema migration。

## 上游观察卡

完成实验后复制并填写：

```text
观察对象：@deepseek-ai/dsh-session-projection / ProjectionDefinition + drive / b150a551b8...
预期行为：
实际行为：
复现命令：corepack pnpm test:s04
证据：
分类：学习误解 / 文档歧义 / 兼容性问题 / 可复现缺陷 / 插件机会
下一步：留在课程 / 写指南 / 发布插件 / 发 Discussion
```

如果只是自己的 `apply` 原地修改 state，它属于学习修正；只有真实公开 API 在固定版本、最小复现和 clean 环境中违背契约，才整理成上游反馈。
