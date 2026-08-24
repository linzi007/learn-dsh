# 01：Plugin、Fiber 与 Effect——Cordis 生命周期显微镜

> 一句话目标：不用 `process.exit()` 掩盖问题，用事件轨迹和测试亲眼证明“谁创建资源，谁负责清理”。

- 预计时间：45-60 分钟
- 前置知识：TypeScript 函数、`async/await`
- Cordis 前置：无；本章从基本概念开始
- API Key：不需要
- 上一章：无
- 下一章：Service seam（计划中）

## 问题

Harness 会长期持有 timer、socket、watcher、MCP 子进程和 background job。一个功能模块被卸载、热重载或失去依赖时，如果程序只移除了功能本身，却没有释放它创建的资源，进程就会泄漏、重复监听，甚至继续执行已经失效的逻辑。

Cordis 用一组生命周期概念解决这个问题。先不要背 API，先分清“功能定义”“运行实例”和“实例拥有的资源”。

## 先认识五个基本概念

### 1. Context：当前插件的工作上下文

`Context` 通常写作 `ctx`。你可以先把它理解为：**当前插件能访问哪些能力，以及通过这些能力注册的内容归谁管理**。

- 根程序从 `new Context()` 开始。
- 一个 Plugin 被挂载后，会收到属于这次运行实例的子 Context。
- 在这个 `ctx` 上注册的子插件、监听器和 effect，会绑定到当前 Fiber 的生命周期。

它不只是一个随便装数据的对象；Cordis 还用它解析 service、隔离作用域和追踪资源所有权。

### 2. Plugin：可挂载的功能定义

Plugin 描述“加载这个功能时要做什么”。最简单的 Plugin 就是一个接收 `ctx` 的函数：

```ts
function helloPlugin(ctx: Context) {
  console.log('plugin is running')
}
```

这段函数只是**定义**。它像一份配方，本身还没有成为运行中的实例。Cordis 还支持对象 Plugin 和 `Service` class，本章只使用函数形式。

### 3. Fiber：Plugin 的一次运行实例

调用 `ctx.plugin(helloPlugin)` 后，Cordis 会为这次挂载创建一个 `Fiber`：

```ts
const fiber = root.plugin(helloPlugin)
await fiber.await()
```

Plugin 是功能定义，Fiber 是它被挂载后产生的**运行实例和生命周期句柄**。同一个 Plugin 挂载两次，会得到两个不同的 Fiber。

Fiber 记录加载状态、依赖、当前 Context 和待清理内容。你可以用它等待加载完成、更新配置或卸载实例。这里的 Fiber 不是操作系统线程，也不是 React Fiber。

### 4. Effect：登记到 Fiber 名下的外部影响

功能常常会改变外部世界，例如启动 timer、打开 socket 或监听文件。Cordis 无法猜出每种资源该怎样关闭，所以 Plugin 要用 `ctx.effect(setup)` 明确登记：

```ts
ctx.effect(() => {
  const timer = setInterval(() => {}, 1_000)
  return () => clearInterval(timer)
})
```

`setup` 在加载阶段执行。因为它是在当前 Plugin 的 `ctx` 上登记的，Cordis 知道这个 Effect 归当前 Fiber 所有。

通过 `ctx.plugin()`、`ctx.on()` 等 Cordis API 建立的注册，本身已经带有 Effect 语义；timer、socket、watcher 这类 Cordis 不认识的资源，才需要显式包进 `ctx.effect()`。

### 5. Disposer：撤销 Effect 的清理函数

上面 `return () => clearInterval(timer)` 返回的函数就是 disposer。Fiber 卸载时，Cordis 会调用并等待它：

```ts
await fiber.dispose()
```

disposer 可以同步，也可以异步。`await fiber.dispose()` 会等待所有已登记 disposer 的执行尝试 settle。不过在当前 Cordis 基线中，单个 disposer 抛错会被记录后继续卸载，所以 `dispose()` resolve 只证明框架完成了清理流程，不自动证明每个外部资源都释放成功。生产代码仍要像本章的 `ResourceLedger` 一样验证关键清理后置条件。

把五者连成一句话：

```text
Context 挂载 Plugin
  → 产生一个 Fiber 运行实例
  → Plugin 在自己的 Context 上登记 Effect
  → Effect 返回 Disposer
  → Fiber dispose 时调用 Disposer
```

再看一个完整的最小例子：

```ts
import { Context } from '@deepseek-ai/cordis'

const root = new Context()

function heartbeatPlugin(ctx: Context) {
  ctx.effect(() => {
    const timer = setInterval(() => {}, 1_000)
    return () => clearInterval(timer)
  })
}

const fiber = root.plugin(heartbeatPlugin)
await fiber.await()   // 等 Plugin 加载稳定
await fiber.dispose() // 调用 disposer，等待 timer 被清理
```

读完先回答三个小问题：

1. `heartbeatPlugin` 和 `fiber` 哪个是定义，哪个是运行实例？
2. timer 为什么归这个 Fiber 管，而不是归整个进程自动管理？
3. 如果 `setInterval()` 写在 `ctx.effect()` 外，Fiber 从哪里知道要调用 `clearInterval()`？

## 你会交付什么

本章完成三个确定性实验：

1. 显式 `fiber.dispose()`，资源计数回到 0。
2. 调用根 Fiber 的清理入口，子插件被递归清理。
3. 故意在 `ctx.effect()` 外创建资源，测试探针捕获泄漏。

最终证据不是“程序看起来退出了”，而是事件轨迹、fiber 状态和资源账本的自动断言。

## 机制图

```text
root Context / root Fiber
  └─ child Fiber（一次 Plugin 运行实例）
       └─ ctx.effect(setup)
            ├─ acquire resource
            └─ return disposer

child.dispose() 或 root.fiber.dispose()
  → 等待 child 卸载
  → 调用 disposer
  → release resource
  → child.uid === null
```

反例：

```text
child Fiber     resource
    │              ▲
    └─ acquire ────┘    （没有注册 effect 所有权）

child.dispose() ──────→ 框架不知道怎样释放 resource
```

## 本章边界

本章只学习 Context、Plugin、Fiber、Effect 和 Disposer，以及它们之间的所有权关系。先不进入 service、event、session 或 agent loop。

## 手把手实验

### 第 1 步：运行生命周期轨迹

在仓库根目录执行：

```bash
corepack pnpm demo:s01
```

先只观察前两个场景。关键顺序应为：

```text
plugin:mounted
resource:acquired
host:dispose-*
resource:released
effect:cleaned
host:*-disposed
```

观察重点：

- effect 主体在插件加载时立即获取资源。
- 在本章成功场景中，`dispose()` 返回前，disposer 已成功归还资源。
- 调用根 Fiber 的清理入口也会递归卸载子 Fiber。
- 根 Fiber 清理后仍能挂载一个新的探针 Plugin，证明根 Context 可复用。

### 第 2 步：找到所有权边界

打开 [`src/lifecycle-lab.ts`](src/lifecycle-lab.ts)，定位：

```ts
ctx.effect(() => {
  const release = ledger.acquire(resourceId)
  return () => {
    release()
  }
})
```

`ResourceLedger` 是本课程的教学探针，把 timer/socket/watcher 抽象成可稳定断言的资源计数。真正提供生命周期所有权的是 `ctx.effect()`，不是账本。

### 第 3 步：让测试替你检查理解

```bash
corepack pnpm test:s01
```

测试检查：

- 在本章成功场景中，`resource:released` 发生在 `dispose()` 返回之前。
- 子 fiber 最终 `uid === null`。
- active resources 最终为空。
- 负例的资源只能由实验宿主兜底清理。

## 负向实验

先阅读 `createLeakyResourcePlugin()`。它故意没有调用 `ctx.effect()`：

```ts
emergency.release = ledger.acquire(resourceId)
```

虽然 fiber 成功 dispose，`leaky-connection` 仍在资源账本中。demo 中的第三个 `PASS` 表示“泄漏探针成功抓住错误”，不是表示泄漏写法正确。

亲手制造一次同类错误。请把 `createManagedResourcePlugin()` 中的**整个** `ctx.effect(...)` 区块临时替换成下面这一行，而不是只移动 `acquire()` 的位置：

```ts
ledger.acquire(resourceId) // 故意丢弃 release，也没有登记 disposer
```

完整步骤：

1. 用上面的坏代码替换 `ctx.effect(...)` 整块，保存文件。
2. 运行 `corepack pnpm test:s01`。
3. 预期前两个生命周期测试失败，并报告 active resource 或事件轨迹不符合预期。
4. 阅读失败断言，确认 Fiber 已进入清理路径，但它没有拿到 `release()` disposer。
5. 恢复原来的 `ctx.effect(() => disposer)` 区块，再次运行测试直到通过。

如果只是把 `ledger.acquire()` 移到 Effect setup 之前，但仍把它的 `release()` 作为 disposer 返回，资源所有权依然存在，测试理应继续通过；那不是本实验要制造的错误。

不要用 `process.exit()` 让进程强退；那只会隐藏资源所有权错误。

## 对照真实源码

本章直接运行真实 `@deepseek-ai/cordis@4.0.1`，不是自制的 plugin 框架。

- `Context` 构造函数创建根 fiber。
- `ctx.plugin()` 返回子 `Fiber`。
- `Fiber.effect()` 立即执行 setup、收集 disposer，并保证单次清理。
- `Fiber.dispose()` 会等待插件卸载和异步 disposer。

当前 Cordis 基线中的根 Fiber 是特殊宿主：`root.fiber.dispose()` 会通过 restart 语义运行后代和根级 effects 的清理流程，再让根 Context 回到可用状态；它不会像普通子 Fiber 一样把根的 `uid` 置为 `null`。本章第二个场景还用资源账本验证 disposer 成功，并重新挂载探针 Plugin；它证明的是“本实验的 composition 清理后可复用”，不是“根 Context 对象永久不可再用”。

固定版本源码入口见仓库根目录 [UPSTREAM.md](../UPSTREAM.md)。请优先沿 symbol 阅读，不要记忆会随版本漂移的行号。

## 验收

运行：

```bash
corepack pnpm demo:s01
corepack pnpm test:s01
```

| 状态 | 判定 |
| --- | --- |
| Pass | 能解释两种 dispose 路径；4 个测试通过；能说明为何负例在 fiber 已销毁后仍泄漏 |
| Fix | demo 能运行，但测试、环境版本或某一步文档无法复现 |
| Not yet | 只能复述 API，尚未亲手制造失败并用证据定位所有权问题 |

完成后，用一句自己的话回答：**为什么“fiber 已经 disposed”不等于“插件创建的所有资源都已释放”？**

## 教学简化与生产差异

- `ResourceLedger` 是确定性教学探针，生产代码管理的是 timer、socket、watcher、子进程等真实资源。
- 本章使用代码直接挂载函数插件；真实 DSH 还会通过 YAML composition、Loader、service dependency 和 HMR 改变生命周期。
- 本章 disposer 是同步函数；真实 disposer 可能异步。Cordis 会等待它们，但多个异步 disposer 可能并发运行，有顺序依赖的步骤应放进同一个 disposer 内顺序 `await`。
- 本章负例只覆盖“没有登记 disposer”。另一条生产风险是“disposer 已登记但执行失败”；Cordis 会记录这类错误并继续卸载，因此关键资源还需要独立的释放后置条件或监控。
- 本章没有模拟进程崩溃；disposer 只能覆盖正常卸载路径，不能替代持久化和崩溃恢复。

## 上游观察卡

完成实验后复制并填写：

```text
观察对象：@deepseek-ai/cordis / Fiber.effect / b150a551b8...
预期行为：
实际行为：
复现命令：corepack pnpm test:s01
证据：
分类：学习误解 / 文档歧义 / 兼容性问题 / 可复现缺陷 / 插件机会
下一步：留在课程 / 写指南 / 发布插件 / 发 Discussion
```

如果只是自己遗漏了 `ctx.effect()`，它是学习记录；如果固定版本在最小用例中违背文档约定，才整理成带环境、预期、实际和日志的上游 Discussion。
